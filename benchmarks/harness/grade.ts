// The grader: runs every scenario against one build and writes the verdicts.
//
//   node --experimental-strip-types harness/grade.ts --build <dir> --task ngn-bank-offramp [--only crash]
//
// Each scenario gets a fresh simulator and a fresh copy of the app's database, runs the app as real
// processes, injects one fault, drives the contract routes, waits until everything is final, and
// compares the app's books with GlobalStack's ledger. Outcomes: pass, incomplete, unsafe.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EVAL_IDS, Sim, type SimOptions } from '../../src/sandbox/sim.ts';
import type { SimEvent } from '../../src/sandbox/events.ts';
import { App, ensurePostgres, prepareDb, sleep } from './app.ts';
import { jobList, t8Approve, t8Customer, t8Onboard, TASKS_BY_ID, type Check, type Ctx, type Task } from './tasks.ts';

/** The simulator reads the plugin's catalog when a Sim is built. */
process.env.GLOBALSTACK_CATALOG ??= fileURLToPath(new URL('../../plugin/skills/globalstack-testing/catalog.json', import.meta.url));

export const SIM_KEY = 'gsa_sk_live_eval_simulator_key_000000000000';
/** Webhook URLs must be https (C§9); the simulator delivers this origin to the app's local port. */
const PUBLIC_URL = 'https://merchant-app.eval.test';
const EXECUTE = /^POST \/v1\/(offramps|onramps|conversions|transfers)$/;
// The money write limiter covers /v1/offramps, /v1/conversions, /v1/transfers, not onramps (M§1 step 4).
const LIMITED = /^POST \/v1\/(offramps|conversions)(\/quotes)?$|^POST \/v1\/transfers$/;
const HOUR = 3600_000;

export type Outcome = 'pass' | 'incomplete' | 'unsafe' | 'broken';

export interface Verdict {
  scenario: string;
  outcome: Outcome;
  notes: string[];
  seconds: number;
}

interface Scenario {
  name: string;
  /** Tasks it applies to; all when absent. */
  tasks?: string[];
  seed?: Partial<SimOptions>;
  /** Arms faults, drives the app, and returns whether the flow should have completed. */
  run(ctx: Ctx, task: Task): Promise<boolean>;
}

/** Waits until the app has stopped calling GlobalStack for a moment and nothing is in flight. */
async function quiet(ctx: Ctx, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (Date.now() - ctx.sim.http.lastRequestAt > 1500 && ctx.sim.gs.allFinal()) break;
    await sleep(250);
  }
  await ctx.sim.events.drain();
}

/** Lets the app finish its work, then lets two hours pass so pollers and retries run. */
async function settle(ctx: Ctx): Promise<void> {
  await sleep(1000);
  await quiet(ctx, 25_000);
  for (let i = 0; i < 2; i++) {
    await ctx.sim.jump(HOUR);
    await sleep(1000);
    await quiet(ctx, 15_000);
  }
}


/** Movements of one kind at GlobalStack. */
const movesOf = (ctx: Ctx, kind: string) => [...ctx.sim.gs.movements.values()].filter((m) => m.kind === kind);

/** A mid-scenario money check: GlobalStack has moved nothing for the user yet, so the books must not have either. */
async function noMoneyMovedYet(ctx: Ctx, task: Task, what: string): Promise<void> {
  const c = await task.check(ctx, false);
  if (c.unsafe.length) throw new Unsafe(`${what}: ${c.unsafe.join('; ')}`);
}

/** A forged deposit.confirmed: the real event's deposit at ten times the amount, signed with the wrong key. */
function forgeDeposit(ctx: Ctx, real: SimEvent): void {
  const object = real.payload.event_object as Record<string, unknown>;
  const inflated = (Number(object.destination_amount) * 10).toFixed(6);
  const id = `evt_${randomUUID()}`;
  const forged: SimEvent = {
    id, type: real.type, createdAt: ctx.sim.clock.now(),
    payload: { ...real.payload, event_id: id, event_object: { ...object, source_amount: inflated, destination_amount: inflated } },
  };
  const events = ctx.sim.events as unknown as { endpoints: Map<string, { active: boolean; event_categories: string[] }>; deliver(e: unknown, ev: SimEvent, attempt: number, forged: boolean): void };
  for (const endpoint of events.endpoints.values()) {
    if (endpoint.active && endpoint.event_categories.includes('deposit')) events.deliver(endpoint, forged, 0, true);
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'happy-path',
    async run(ctx, task) {
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'lost-response',
    async run(ctx, task) {
      ctx.sim.faults = { dropResponse: { match: task.execute ?? EXECUTE, count: 1 } };
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'crash',
    async run(ctx, task) {
      ctx.sim.faults = { hold: { match: task.execute ?? EXECUTE, armed: true } };
      const pending = task.start(ctx);
      const held = await Promise.race([ctx.sim.http.waitForHold().then(() => true), sleep(20_000).then(() => false)]);
      if (held) {
        ctx.app.crash();
        ctx.sim.http.release();
        await pending;
        await sleep(300);
        if (!(await ctx.app.start())) throw new Error('the app did not restart');
        // A payer who never saw the bank details tries again (zar-bank-onramp: the instructions died with the app).
        if (task.retryAfterCrash) await task.start(ctx);
      } else {
        await pending;
      }
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'provider-error',
    tasks: ['xaf-mobile-money-onramp', 'ngn-bank-offramp', 'kes-mpesa-offramp-webhooks', 'usdc-to-ngn-wallet-conversion', 'usdc-base-withdrawal', 'kes-bank-offramp-seller-kyc', 'kes-bank-offramp-returns', 'zar-bank-offramp-short-prompt', 'xaf-mobile-money-offramp-postgres'],
    async run(ctx, task) {
      ctx.sim.behaviour = { failNextExecutes: 1 };
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'rate-limit',
    tasks: ['ngn-bank-offramp', 'kes-mpesa-offramp-webhooks', 'usdc-to-ngn-wallet-conversion', 'usdc-base-withdrawal', 'kes-bank-offramp-seller-kyc', 'kes-bank-offramp-returns', 'zar-bank-offramp-short-prompt', 'xaf-mobile-money-offramp-postgres'],
    async run(ctx, task) {
      ctx.sim.faults = { rateLimit: { match: LIMITED, count: 2 } };
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'webhook-noise',
    async run(ctx, task) {
      ctx.sim.delivery = 'noisy';
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'webhook-silence',
    async run(ctx, task) {
      ctx.sim.delivery = 'silent';
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  // ── Combined problems: real incidents stack. Each pairs two of the single problems above. ──
  {
    name: 'combo-crash-silence',
    async run(ctx, task) {
      // The app crashes mid-payment AND no webhook ever arrives: only its restart and its poller can finish it.
      ctx.sim.delivery = 'silent';
      ctx.sim.faults = { hold: { match: task.execute ?? EXECUTE, armed: true } };
      const pending = task.start(ctx);
      const held = await Promise.race([ctx.sim.http.waitForHold().then(() => true), sleep(20_000).then(() => false)]);
      if (held) {
        ctx.app.crash();
        ctx.sim.http.release();
        await pending;
        await sleep(300);
        if (!(await ctx.app.start())) throw new Error('the app did not restart');
        if (task.retryAfterCrash) await task.start(ctx);
      } else {
        await pending;
      }
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'combo-lost-noisy',
    async run(ctx, task) {
      // The execute's answer is lost AND webhooks are duplicated, late and forged.
      ctx.sim.delivery = 'noisy';
      ctx.sim.faults = { dropResponse: { match: task.execute ?? EXECUTE, count: 1 } };
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'combo-provider-ratelimit',
    tasks: ['ngn-bank-offramp', 'kes-mpesa-offramp-webhooks', 'usdc-to-ngn-wallet-conversion', 'usdc-base-withdrawal', 'kes-bank-offramp-seller-kyc', 'kes-bank-offramp-returns', 'zar-bank-offramp-short-prompt', 'xaf-mobile-money-offramp-postgres'],
    async run(ctx, task) {
      // The provider fails the first execute AND the retries hit the rate limit.
      ctx.sim.behaviour = { failNextExecutes: 1 };
      ctx.sim.faults = { rateLimit: { match: LIMITED, count: 2 } };
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'slow-truth',
    async run(ctx, task) {
      ctx.sim.behaviour = { holdFinal: true };
      await task.start(ctx);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && ![...ctx.sim.gs.movements.values()].some((m) => m.status === 'processing')) await sleep(200);
      await sleep(1000);
      await ctx.sim.jump(3 * HOUR);
      await sleep(2500);
      ctx.sim.behaviour = { holdFinal: false };
      ctx.sim.gs.finishHeld('success');
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'access-pending',
    tasks: ['xaf-mobile-money-onramp'],
    seed: { xafAccess: 'pending' },
    async run(ctx, task) {
      await task.start(ctx);
      await sleep(1500);
      const early = [...ctx.sim.gs.movements.values()].some((m) => m.kind === 'onramp');
      ctx.sim.gs.approveAccess('XAF', 'CM');
      await task.start(ctx);
      await settle(ctx);
      if (early) throw new Unsafe('an onramp started before access was granted');
      return true;
    },
  },
  {
    name: 'route-closed',
    tasks: ['zar-bank-onramp'],
    async run(ctx, task) {
      ctx.sim.gs.setCapability('ZAR', 'ZA', 'can_onramp', false);
      await task.start(ctx);
      await sleep(1500);
      ctx.sim.gs.setCapability('ZAR', 'ZA', 'can_onramp', true);
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'wrong-account',
    tasks: ['ngn-bank-offramp'],
    async run(ctx, task) {
      await task.start(ctx, { who: 'u_chika', amount: '20.00' });
      await settle(ctx);
      return false;
    },
  },
  {
    name: 'withdraw-all',
    tasks: ['ngn-bank-offramp'],
    async run(ctx, task) {
      await task.start(ctx, { who: 'u_ada', amount: 'all' });
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'double-spend',
    tasks: ['ngn-bank-offramp'],
    async run(ctx, task) {
      await Promise.all([task.start(ctx, { who: 'u_tunde', amount: 'all' }), task.start(ctx, { who: 'u_tunde', amount: 'all' })]);
      await settle(ctx);
      return true;
    },
  },
  // ── usdc-base-deposit-addresses ──
  {
    name: 'two-users',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      await task.start(ctx, { who: 'u_amara', amount: '100.00' });
      await task.start(ctx, { who: 'u_kofi', amount: '7.250000' });
      await task.start(ctx, { who: 'u_amara', amount: '30.50' }); // asks again: same address, second deposit
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'deposit-slow-confirm',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      // deposit.received now; the chain confirms three hours later.
      await task.start(ctx, { flow: 'manual' });
      await settle(ctx);
      await noMoneyMovedYet(ctx, task, 'credited a deposit that was received but not confirmed');
      for (const id of ctx.sim.gs.payins.depositStates.keys()) ctx.sim.gs.confirmDeposit(id);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'deposit-held',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      // Over our tier's money-in cap: GlobalStack holds the deposit (deposit.held), then ops release it.
      ctx.sim.behaviour = { tierCapsUsd: { tier_1: '1000000', tier_2: '50' } };
      await task.start(ctx, { amount: '100.00' });
      await settle(ctx);
      await noMoneyMovedYet(ctx, task, 'credited a deposit GlobalStack is holding');
      for (const [id, st] of ctx.sim.gs.payins.depositStates) if (st.row.status === 'received') ctx.sim.gs.releaseHeldDeposit(id);
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'deposit-voided',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      // Received, then ops void the inflight credit: the deposit ends failed (deposit.failed), nothing to credit.
      await task.start(ctx, { flow: 'manual' });
      await sleep(1000);
      await quiet(ctx, 10_000);
      for (const id of ctx.sim.gs.payins.depositStates.keys()) {
        ctx.sim.gs.voidDepositHold(id);
        ctx.sim.gs.confirmDeposit(id);
      }
      await settle(ctx);
      return false;
    },
  },
  {
    name: 'deposit-crash',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      // The app is down when the deposit is confirmed; GlobalStack's webhook retries and polling must still credit it once.
      await task.start(ctx, { flow: 'manual' });
      await sleep(1000);
      await quiet(ctx, 10_000);
      ctx.app.crash();
      for (const id of ctx.sim.gs.payins.depositStates.keys()) ctx.sim.gs.confirmDeposit(id);
      await sleep(2500);
      if (!(await ctx.app.start())) throw new Error('the app did not restart');
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'deposit-duplicate-events',
    tasks: ['usdc-base-deposit-addresses'],
    async run(ctx, task) {
      // Every event twice, then all deposit events again in reverse order, then a forged deposit.confirmed for 10x.
      ctx.sim.delivery = 'noisy';
      await task.start(ctx);
      await sleep(1000);
      await quiet(ctx, 15_000);
      const real = ctx.sim.events.events.filter((e) => e.type.startsWith('deposit.'));
      for (const e of [...real].reverse()) ctx.sim.events.replay(e);
      const confirmed = real.find((e) => e.type === 'deposit.confirmed');
      if (confirmed) forgeDeposit(ctx, confirmed);
      await settle(ctx);
      return true;
    },
  },

  // ── kes-bank-offramp-seller-kyc: seller onboarding and KYC-gated payouts ──
  {
    name: 'kyc-approved',
    tasks: ['kes-bank-offramp-seller-kyc'],
    async run(ctx, task) {
      const customer = await t8Onboard(ctx, 's_njeri');
      await sleep(500);
      if (customer) {
        ctx.sim.gs.startVerification(customer);
        await sleep(1000);
        t8Approve(ctx, 's_njeri');
      }
      await sleep(2000);
      await task.start(ctx, { kyc: 'skip' });
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'kyc-pending',
    tasks: ['kes-bank-offramp-seller-kyc'],
    async run(ctx, task) {
      // Payouts asked while verification is in progress, then after a resubmission request: both refused, nothing paid.
      await task.start(ctx, { kyc: 'pending' });
      const customer = t8Customer(ctx, 's_njeri');
      if (customer) ctx.sim.gs.startVerification(customer);
      await task.start(ctx, { kyc: 'skip' });
      if (customer) ctx.sim.gs.rejectVerification(customer, { retry: true });
      await sleep(1000);
      await task.start(ctx, { kyc: 'skip' });
      await settle(ctx);
      if (movesOf(ctx, 'offramp').length) throw new Unsafe('an offramp started while the seller was not verified');
      // Approved at last: the next payout goes out.
      t8Approve(ctx, 's_njeri');
      await sleep(1500);
      await task.start(ctx, { kyc: 'skip' });
      await settle(ctx);
      return true;
    },
  },
  {
    name: 'kyc-rejected',
    tasks: ['kes-bank-offramp-seller-kyc'],
    async run(ctx, task) {
      const customer = await t8Onboard(ctx, 's_njeri');
      if (customer) {
        ctx.sim.gs.startVerification(customer);
        ctx.sim.gs.rejectVerification(customer, { reason: 'document_invalid' });
      }
      await sleep(1500);
      await task.start(ctx, { kyc: 'skip' });
      await settle(ctx);
      return false;
    },
  },
  {
    name: 'onboarding-lost-response',
    tasks: ['kes-bank-offramp-seller-kyc'],
    async run(ctx, task) {
      // The answer to creating the seller's customer is lost; the seller also taps "verify" twice.
      ctx.sim.faults = { dropResponse: { match: /^POST \/v1\/customers$/, count: 1 } };
      await t8Onboard(ctx, 's_baraka');
      await t8Onboard(ctx, 's_baraka');
      t8Approve(ctx, 's_baraka');
      await sleep(1000);
      await task.start(ctx, { who: 's_baraka', amount: '9000', kyc: 'skip' });
      await settle(ctx);
      return true;
    },
  },

  // ── kes-bank-offramp-returns: returned after success ──
  {
    name: 'returned-after-success',
    tasks: ['kes-bank-offramp-returns'],
    async run(ctx, task) {
      await task.start(ctx);
      await settle(ctx);
      for (const m of movesOf(ctx, 'offramp')) if (m.status === 'success') ctx.sim.gs.returnMovement(m.id);
      await settle(ctx);
      return false;
    },
  },
  {
    name: 'returned-noisy',
    tasks: ['kes-bank-offramp-returns'],
    async run(ctx, task) {
      // The bank returns it and every webhook arrives twice: refund exactly once.
      await task.start(ctx);
      await settle(ctx);
      ctx.sim.delivery = 'noisy';
      for (const m of movesOf(ctx, 'offramp')) if (m.status === 'success') ctx.sim.gs.returnMovement(m.id);
      await settle(ctx);
      return false;
    },
  },

  // ── xaf-mobile-money-offramp-postgres: XAF is gated (access request pending) ──
  {
    name: 'access-pending-payout',
    tasks: ['xaf-mobile-money-offramp-postgres'],
    seed: { xafAccess: 'pending' },
    async run(ctx, task) {
      await task.start(ctx);
      await sleep(1500);
      ctx.sim.gs.approveAccess('XAF', 'CM');
      await task.start(ctx);
      await settle(ctx);
      return true;
    },
  },
];

class Unsafe extends Error {}

/** A port the OS says is free right now. */
/**
 * A free port for the app, picked outside the OS ephemeral range (49152+ on macOS). The app binds it only seconds
 * later, and in between another grader's listen(0) can take an ephemeral port: with several graders in parallel
 * that sent one app's traffic to another grader's simulator.
 */
async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.unref();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

async function runScenario(buildDir: string, task: Task, scenario: Scenario, workRoot: string): Promise<Verdict> {
  const t0 = Date.now();
  const workDir = join(workRoot, scenario.name);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const app = new App({
    buildDir, workDir, port: await freePort(), simUrl: '', secretKey: SIM_KEY, publicUrl: PUBLIC_URL,
    customerId: EVAL_IDS.treasuryCustomerId, walletId: EVAL_IDS.usdcWalletId,
    extraEnv: { GLOBALSTACK_NGN_WALLET_ID: EVAL_IDS.ngnWalletId },
    dbKind: task.db ?? 'sqlite',
  });
  const sim = new Sim({ secretKey: SIM_KEY, clockFile: app.clockFile, publicUrl: { from: PUBLIC_URL, to: app.baseUrl }, ...scenario.seed });
  app.env.simUrl = await sim.listen(0);
  prepareDb(app.dbPath, task.schema, task.rows);
  const ctx: Ctx = { sim, app, started: [] };
  const done = (outcome: Outcome, notes: string[]): Verdict => ({ scenario: scenario.name, outcome, notes, seconds: Math.round((Date.now() - t0) / 100) / 10 });
  try {
    const setupCode = await app.setup();
    if (setupCode !== 0) return done('broken', [`npm run setup exited ${setupCode}`]);
    if (!(await app.start())) return done('broken', ['the app did not start']);
    let expectDone: boolean;
    try {
      expectDone = await scenario.run(ctx, task);
    } catch (err) {
      if (err instanceof Unsafe) return done('unsafe', [err.message]);
      throw err;
    }
    const check: Check = await task.check(ctx, expectDone);
    const notes = [...check.unsafe, ...check.incomplete];
    for (const s of ctx.started) {
      if (s.status === 0 || s.status >= 300) notes.push(`app answered ${s.status || 'nothing'} to ${JSON.stringify(s.args)}${s.text ? `: ${s.text.slice(0, 160)}` : ''}`);
    }
    return done(check.unsafe.length ? 'unsafe' : check.incomplete.length ? 'incomplete' : 'pass', notes);
  } catch (err) {
    return done('broken', [`grader error: ${(err as Error).message}`]);
  } finally {
    await app.stop();
    app.close();
    writeFileSync(join(workDir, 'sim-requests.json'), JSON.stringify(sim.http.log, null, 1));
    writeFileSync(join(workDir, 'sim-movements.json'), JSON.stringify([...sim.gs.movements.values()].map(({ _private, ...m }) => m), null, 1));
    writeFileSync(join(workDir, 'sim-deliveries.json'), JSON.stringify(sim.events.deliveries, null, 1));
    await sim.close();
  }
}

export async function gradeBuild(dir: string, taskId: string, only?: string): Promise<Verdict[]> {
  const buildDir = resolve(dir);
  const task = TASKS_BY_ID[taskId];
  if (!task) throw new Error(`unknown task ${taskId}`);
  const workRoot = join(buildDir, '.grade');
  const verdicts: Verdict[] = [];
  if (task.db === 'postgres') ensurePostgres();
  for (const scenario of SCENARIOS) {
    if (scenario.tasks && !scenario.tasks.includes(task.base ?? taskId)) continue;
    if (task.skip?.includes(scenario.name)) continue;
    if (only && scenario.name !== only) continue;
    const v = await runScenario(buildDir, task, scenario, workRoot);
    verdicts.push(v);
    console.log(`${taskId} ${scenario.name.padEnd(16)} ${v.outcome.padEnd(10)} ${v.seconds}s ${v.notes.join(' | ')}`);
  }
  writeFileSync(join(workRoot, 'verdicts.json'), JSON.stringify(verdicts, null, 1));
  return verdicts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { build: { type: 'string' }, task: { type: 'string' }, only: { type: 'string' } } });
  if (!values.build || !values.task) {
    console.error('usage: grade.ts --build <dir> --task <job, e.g. ngn-bank-offramp> [--only <scenario>]');
    process.exit(2);
  }
  await gradeBuild(values.build, values.task === 'T3P' ? values.task : jobList(values.task)[0]!, values.only);
}
