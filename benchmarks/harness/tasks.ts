// What each task looks like to the grader: the rows already in the app's database, how to start one
// money movement through the app's contract, and the money check against GlobalStack's ledger.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatAmount, parseAmount, roundDown, type Units } from '../../src/sandbox/core.ts';
import type { Sim } from '../../src/sandbox/sim.ts';
import { readRows, type App } from './app.ts';

/** One folder per job, named after what it tests: task.md, schema.sql and the reference app. */
const JOBS = fileURLToPath(new URL('../../benchmarks/', import.meta.url));

export interface Ctx {
  sim: Sim;
  app: App;
  /** Every response the app gave to a start call, in order. */
  started: Array<{ status: number; json: any; text: string; args: StartArgs }>;
}

export interface StartArgs {
  /** Which seeded entity starts the movement; defaults to the task's main one. */
  who?: string;
  amount?: string;
  /** usdc-base-deposit-addresses: how the on-chain deposit to the address is reported (sim DepositOptions.flow), or 'none' for no deposit. */
  flow?: 'auto' | 'manual' | 'direct' | 'none';
  /** kes-bank-offramp-seller-kyc: what the grader's KYC provider does before the payout: approve (default), leave pending, or nothing. */
  kyc?: 'approve' | 'pending' | 'skip';
}

/** The money check's result: problems that make the build unsafe, and reasons it did not finish. */
export interface Check {
  unsafe: string[];
  incomplete: string[];
}

export interface Task {
  id: string;
  schema: string;
  rows: Record<string, Array<Record<string, string>>>;
  /** Starts one movement through the app's contract (and pays the deposit when the flow needs it). */
  start(ctx: Ctx, args?: StartArgs): Promise<{ status: number; json: any; text: string }>;
  /** Compares the app's books with GlobalStack's final state. `expectDone`: the flow should have finished. */
  check(ctx: Ctx, expectDone: boolean): Promise<Check>;
  /** The user needs the app's answer to go on (bank details), so after a crash they ask again. */
  retryAfterCrash?: boolean;
  /** The app's database. Postgres tasks get a fresh database per scenario and the Postgres starter app. */
  db?: 'sqlite' | 'postgres';
  /** The task whose scenarios this one shares (a variant, e.g. on another database). */
  base?: string;
  /** The GlobalStack call the generic lost-response and crash scenarios hit; default: the money executes. */
  execute?: RegExp;
  /** Generic scenarios that make no sense for this task. */
  skip?: string[];
}

const dec = (s: unknown): Units => parseAmount(String(s ?? '0')) ?? 0n;
/** A request the app accepted, or whose answer was lost (crash): it may legitimately move money. */
const accepted = (s: { status: number }) => s.status === 0 || (s.status >= 200 && s.status < 300);
const show = (u: Units) => formatAmount(u, 6);
const schema = (id: string) => readFileSync(`${JOBS}${id}/schema.sql`, 'utf8');
const movements = (sim: Sim, kind: string) => [...sim.gs.movements.values()].filter((m) => m.kind === kind);
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '').slice(-9);

async function call(ctx: Ctx, path: string, body: Record<string, unknown>, args: StartArgs) {
  const res = await ctx.app.call('POST', path, body);
  ctx.started.push({ ...res, args });
  return res;
}

/** Waits until the app has created an onramp at GlobalStack, then the payer pays it. */
async function payNewestDeposit(ctx: Ctx, before: Set<string>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const fresh = movements(ctx.sim, 'onramp').filter((m) => !before.has(m.id) && m.status === 'awaiting_deposit');
    if (fresh.length) {
      for (const m of fresh) ctx.sim.gs.payDeposit(m.id);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function balances(app: App, table: string): Map<string, Units> {
  return new Map(readRows(app.dbPath, `SELECT id, usdc_balance FROM ${table}`).map((r) => [String(r.id), dec(r.usdc_balance)]));
}

/** Balance books: start + credits − debits at GlobalStack must equal the app's balance, per user. */
function checkBalances(
  seedRows: Array<Record<string, string>>,
  now: Map<string, Units>,
  moved: (row: Record<string, string>) => { delta: Units; done: boolean; over: boolean },
  expectDone: boolean,
  who: string,
): Check {
  const out: Check = { unsafe: [], incomplete: [] };
  for (const row of seedRows) {
    const start = dec(row.usdc_balance);
    const { delta, done, over } = moved(row);
    const expected = start + delta;
    const actual = now.get(row.id);
    if (actual === undefined) {
      out.unsafe.push(`${row.id} vanished from the books`);
      continue;
    }
    if (actual !== expected) {
      out.unsafe.push(`${row.id}: books say ${show(actual)}, GlobalStack's ledger implies ${show(expected)} (start ${show(start)}, moved ${show(delta)})`);
    }
    if (over) out.unsafe.push(`${row.id}: GlobalStack moved more than was asked`);
    if (row.id === who && expectDone && !done) out.incomplete.push(`${row.id}: the movement did not complete`);
  }
  return out;
}

// ── xaf-mobile-money-onramp (T1): XAF mobile money top-ups (onramp) ──
const T1_USERS = [
  { id: 'u_marie', full_name: 'Marie Ngono', phone: '+237670000001', usdc_balance: '10.000000' },
  { id: 'u_paul', full_name: 'Paul Biya Mbarga', phone: '+237699000002', usdc_balance: '0.000000' },
];
const T1: Task = {
  id: 'xaf-mobile-money-onramp',
  schema: schema('xaf-mobile-money-onramp'),
  rows: { users: T1_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_marie', amount: args.amount ?? '5000' };
    const user = T1_USERS.find((u) => u.id === a.who)!;
    return call(ctx, '/topups', { user_id: user.id, amount_xaf: a.amount, phone: user.phone }, a);
  },
  async check(ctx, expectDone) {
    const ok = movements(ctx.sim, 'onramp').filter((m) => m.status === 'success');
    return checkBalances(T1_USERS, balances(ctx.app, 'users'), (u) => {
      const mine = ok.filter((m) => digits(m._private.phone) === digits(u.phone));
      return { delta: mine.reduce((s, m) => s + dec(m.received_amount), 0n), done: mine.length > 0, over: mine.length > ctx.started.filter((s) => (s.args.who ?? 'u_marie') === u.id && accepted(s)).length };
    }, expectDone, ctx.started.at(-1)?.args.who ?? 'u_marie');
  },
};

// ── zar-bank-onramp (T2): ZAR bank funding (onramp with deposit instructions) ──
const T2_BUSINESSES = [{ id: 'b_karoo', name: 'Karoo Supplies (Pty) Ltd', registration_number: '2019/123456/07', usdc_balance: '0.000000' }];
const T2: Task = {
  id: 'zar-bank-onramp',
  retryAfterCrash: true,
  schema: schema('zar-bank-onramp'),
  rows: { businesses: T2_BUSINESSES },
  async start(ctx, args = {}) {
    const before = new Set(movements(ctx.sim, 'onramp').map((m) => m.id));
    const a = { who: 'b_karoo', amount: args.amount ?? '1000.00' };
    const res = await call(ctx, '/fundings', { business_id: a.who, amount_zar: a.amount }, a);
    if (res.status >= 200 && res.status < 300) await payNewestDeposit(ctx, before);
    return res;
  },
  async check(ctx, expectDone) {
    const ok = movements(ctx.sim, 'onramp').filter((m) => m.status === 'success');
    return checkBalances(T2_BUSINESSES, balances(ctx.app, 'businesses'), () => ({
      delta: ok.reduce((s, m) => s + dec(m.received_amount), 0n),
      done: ok.length > 0,
      over: ok.length > ctx.started.filter(accepted).length,
    }), expectDone, 'b_karoo');
  },
};

// ── ngn-bank-offramp (T3): NGN bank withdrawals (offramp) ──
const T3_USERS = [
  { id: 'u_ada', full_name: 'Ada Obi', bank_name: 'GTBank', bank_code: '058', account_number: '0123456789', usdc_balance: '152.384211' },
  { id: 'u_tunde', full_name: 'Tunde Bello', bank_name: 'Access Bank', bank_code: '044', account_number: '0987654321', usdc_balance: '80.000000' },
  { id: 'u_chika', full_name: 'Chika Eze', bank_name: 'GTBank', bank_code: '058', account_number: '0000000000', usdc_balance: '40.000000' },
];
function payoutCheck(ctx: Ctx, kind: 'offramp' | 'transfer', rows: Array<Record<string, string>>, accountOf: (r: Record<string, string>) => string, expectDone: boolean, defaultWho: string,
  same: (paidTo: string, account: string) => boolean = (a, b) => a === b): Check {
  const ok = movements(ctx.sim, kind).filter((m) => m.status === 'success');
  return checkBalances(rows, balances(ctx.app, 'users'), (u) => {
    const mine = ok.filter((m) => (kind === 'transfer' ? m.beneficiary?.details?.address?.toLowerCase() === accountOf(u).toLowerCase() : same(String(m.beneficiary?.details?.account_number ?? ''), accountOf(u))));
    const paid = mine.reduce((s, m) => s + dec(kind === 'transfer' ? m.amount : m.source_amount), 0n);
    const asked = ctx.started
      .filter((s) => (s.args.who ?? defaultWho) === u.id && accepted(s))
      .reduce((s, x) => s + (x.args.amount === 'all' ? dec(u.usdc_balance) : dec(x.args.amount)), 0n);
    const allAsked = ctx.started.some((s) => (s.args.who ?? defaultWho) === u.id && s.args.amount === 'all');
    const done = allAsked ? paid >= roundDown(dec(u.usdc_balance), 2) : paid > 0n && paid >= asked;
    return { delta: -paid, done, over: paid > asked || paid > dec(u.usdc_balance) };
  }, expectDone, ctx.started.at(-1)?.args.who ?? defaultWho);
}
const T3: Task = {
  id: 'ngn-bank-offramp',
  schema: schema('ngn-bank-offramp'),
  rows: { users: T3_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_tunde', amount: args.amount ?? '50.00' };
    return call(ctx, '/withdrawals', { user_id: a.who, amount: a.amount }, a);
  },
  check: async (ctx, expectDone) => payoutCheck(ctx, 'offramp', T3_USERS, (u) => u.account_number!, expectDone, 'u_tunde'),
};

// ── kes-mpesa-offramp-webhooks (T4): KES M-Pesa payouts with webhooks (offramp, records) ──
const T4_FREELANCERS = [
  { id: 'f_wanjiku', name: 'Wanjiku Kamau', mpesa_phone: '+254712345678' },
  { id: 'f_otieno', name: 'Otieno Odhiambo', mpesa_phone: '+254722000111' },
];
const T4: Task = {
  id: 'kes-mpesa-offramp-webhooks',
  schema: schema('kes-mpesa-offramp-webhooks'),
  rows: { freelancers: T4_FREELANCERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'f_wanjiku', amount: args.amount ?? '1500' };
    return call(ctx, '/payouts', { freelancer_id: a.who, amount_kes: a.amount }, a);
  },
  async check(ctx, expectDone) {
    const out: Check = { unsafe: [], incomplete: [] };
    const ok = movements(ctx.sim, 'offramp').filter((m) => m.status === 'success');
    for (const f of T4_FREELANCERS) {
      const mine = ok.filter((m) => digits(m.beneficiary?.details?.account_number) === digits(f.mpesa_phone));
      const asks = ctx.started.filter((s) => (s.args.who ?? 'f_wanjiku') === f.id && accepted(s));
      const askedKes = asks.reduce((s, x) => s + dec(x.args.amount ?? '1500'), 0n);
      const paidKes = mine.reduce((s, m) => s + dec(m.received_amount), 0n);
      if (mine.length > asks.length) out.unsafe.push(`${f.id}: paid ${mine.length} times for ${asks.length} payout(s)`);
      for (const m of mine) if (dec(m.received_amount) !== dec(asks[0]?.args.amount ?? '1500')) out.unsafe.push(`${f.id}: received ${m.received_amount} KES instead of ${asks[0]?.args.amount ?? '1500'}`);
      for (const ask of asks) {
        const id = ask.json?.id;
        if (!id) continue;
        const rec = await ctx.app.call('GET', `/payouts/${encodeURIComponent(id)}`);
        const status = rec.json?.status;
        if (paidKes > 0n && status === 'failed') out.unsafe.push(`${f.id}: payout ${id} recorded failed but the freelancer was paid`);
        if (paidKes === 0n && status === 'paid') out.unsafe.push(`${f.id}: payout ${id} recorded paid but nothing was paid`);
        if (status !== 'paid' && status !== 'failed') out.incomplete.push(`${f.id}: payout ${id} still "${status ?? rec.status}" after GlobalStack finished`);
      }
      if (f.id === (ctx.started.at(-1)?.args.who ?? 'f_wanjiku') && expectDone && paidKes < askedKes) out.incomplete.push(`${f.id}: not paid`);
    }
    return out;
  },
};

// ── usdc-to-ngn-wallet-conversion (T5): USDC to NGN conversion into the suppliers wallet ──
const T5: Task = {
  id: 'usdc-to-ngn-wallet-conversion',
  schema: schema('usdc-to-ngn-wallet-conversion'),
  rows: {},
  start: (ctx, args = {}) => {
    const a = { amount: args.amount ?? '150000' };
    return call(ctx, '/ngn-topups', { amount_ngn: a.amount }, a);
  },
  async check(ctx, expectDone) {
    const out: Check = { unsafe: [], incomplete: [] };
    const ok = movements(ctx.sim, 'conversion').filter((m) => m.status === 'success');
    const got = ok.reduce((s, m) => s + dec(m.received_amount), 0n);
    const asked = ctx.started.filter(accepted).reduce((s, x) => s + dec(x.args.amount ?? '150000'), 0n);
    if (ok.length > ctx.started.filter(accepted).length) out.unsafe.push(`converted ${ok.length} times for ${ctx.started.filter(accepted).length} request(s)`);
    if (got > 0n && got !== asked) out.unsafe.push(`NGN wallet received ${formatAmount(got, 2)} instead of ${formatAmount(asked, 2)}`);
    for (const ask of ctx.started) {
      const id = ask.json?.id;
      if (!id) continue;
      const status = (await ctx.app.call('GET', `/ngn-topups/${encodeURIComponent(id)}`)).json?.status;
      if (got > 0n && status === 'failed') out.unsafe.push(`top-up ${id} recorded failed but NGN arrived`);
      if (got === 0n && status === 'completed') out.unsafe.push(`top-up ${id} recorded completed but nothing arrived`);
      if (status !== 'completed' && status !== 'failed') out.incomplete.push(`top-up ${id} still "${status}" after GlobalStack finished`);
    }
    if (expectDone && got < asked) out.incomplete.push('the NGN did not arrive');
    return out;
  },
};

// ── usdc-base-withdrawal (T6): USDC withdrawals to an external Base wallet (transfer) ──
const T6_USERS = [
  { id: 'u_lina', full_name: 'Lina Park', usdc_balance: '120.500000' },
  { id: 'u_omar', full_name: 'Omar Haddad', usdc_balance: '30.000000' },
];
const T6_ADDRESS: Record<string, string> = { u_lina: '0x1111111111111111111111111111111111111111', u_omar: '0x2222222222222222222222222222222222222222' };
const T6: Task = {
  id: 'usdc-base-withdrawal',
  schema: schema('usdc-base-withdrawal'),
  rows: { users: T6_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_lina', amount: args.amount ?? '25.00' };
    return call(ctx, '/crypto-withdrawals', { user_id: a.who, amount_usdc: a.amount, address: T6_ADDRESS[a.who] }, a);
  },
  check: async (ctx, expectDone) => payoutCheck(ctx, 'transfer', T6_USERS, (u) => T6_ADDRESS[u.id]!, expectDone, 'u_lina'),
};

/** ngn-bank-offramp on Postgres: same job and checks, checks the ready-made code's Postgres path. */
const T3P: Task = { ...T3, id: 'ngn-bank-offramp-postgres', base: 'ngn-bank-offramp', db: 'postgres' };

/** Notes a task's start() makes along the way (an address GlobalStack does not know, a KYC link it did not issue). */
const startNotes = new WeakMap<Ctx, Check>();
const notesOf = (ctx: Ctx): Check => {
  let n = startNotes.get(ctx);
  if (!n) startNotes.set(ctx, (n = { unsafe: [], incomplete: [] }));
  return n;
};
const ok2xx = (s: { status: number }) => s.status >= 200 && s.status < 300;

// ── usdc-base-deposit-addresses (T7): USDC deposits to a per-user deposit address ──
const T7_USERS = [
  { id: 'u_amara', full_name: 'Amara Nwosu', usdc_balance: '0.000000' },
  { id: 'u_kofi', full_name: 'Kofi Mensah', usdc_balance: '12.500000' },
];
const T7: Task = {
  id: 'usdc-base-deposit-addresses',
  schema: schema('usdc-base-deposit-addresses'),
  rows: { users: T7_USERS },
  // A lost or held response on creating the address; the user asks again after a crash (they need the address).
  execute: /^POST \/v1\/wallets\/wal_\/deposit-addresses$/,
  retryAfterCrash: true,
  skip: ['slow-truth'],
  async start(ctx, args = {}) {
    const a = { who: args.who ?? 'u_amara', amount: args.amount ?? '100.00' };
    const res = await call(ctx, '/deposit-addresses', { user_id: a.who }, a);
    const address = res.json?.address;
    if (ok2xx(res) && typeof address === 'string' && args.flow !== 'none') {
      try {
        ctx.sim.gs.simulateDeposit(address, a.amount, { flow: args.flow ?? 'auto' });
      } catch {
        notesOf(ctx).unsafe.push(`${a.who}: the address ${address} is not a GlobalStack deposit address; the user's USDC is lost`);
      }
    }
    return res;
  },
  async check(ctx, expectDone) {
    const out: Check = { unsafe: [...notesOf(ctx).unsafe], incomplete: [...notesOf(ctx).incomplete] };
    // Who each address was given to, from the app's answers.
    const owner = new Map<string, string>();
    const given = new Map<string, string>();
    for (const s of ctx.started) {
      const address = s.json?.address;
      if (!ok2xx(s) || typeof address !== 'string') continue;
      const key = address.toLowerCase();
      const who = s.args.who ?? 'u_amara';
      const prev = owner.get(key);
      if (prev && prev !== who) out.unsafe.push(`the address ${address} was given to both ${prev} and ${who}`);
      owner.set(key, who);
      if (given.has(who) && given.get(who) !== key) out.incomplete.push(`${who} asked again and got a different address`);
      given.set(who, key);
    }
    const payIns = ctx.sim.gs.payins.payIns;
    const states = [...ctx.sim.gs.payins.depositStates.values()];
    const addressOf = (payInId: string) => String(payIns.get(payInId)?.details.address ?? '').toLowerCase();
    const res = checkBalances(T7_USERS, balances(ctx.app, 'users'), (u) => {
      const mine = states.filter((st) => owner.get(addressOf(st.payInId)) === u.id);
      // Only a deposit GlobalStack settled (row `success`) is the user's money; received, held, voided are not.
      const settled = mine.filter((st) => st.row.status === 'success');
      return { delta: settled.reduce((sum, st) => sum + st.amount, 0n), done: settled.length > 0, over: false };
    }, expectDone, ctx.started.at(-1)?.args.who ?? 'u_amara');
    out.unsafe.push(...res.unsafe);
    out.incomplete.push(...res.incomplete);
    return out;
  },
};

// ── kes-bank-offramp-seller-kyc (T8): seller onboarding (customer + KYC), then KES bank payouts once approved ──
const T8_SELLERS = [
  { id: 's_njeri', full_name: 'Njeri Wambui', email: 'njeri.wambui@example.co.ke', phone: '+254711000001', address: '12 Moi Avenue, Nairobi', bank_name: 'Equity Bank', bank_code: '68', account_number: '0170299123456' },
  { id: 's_baraka', full_name: 'Baraka Otieno', email: 'baraka.otieno@example.co.ke', phone: '+254722000002', address: '4 Nyerere Road, Mombasa', bank_name: 'Kenya Commercial Bank', bank_code: '01', account_number: '1100223344' },
];
interface T8State {
  /** seller -> the GlobalStack customer behind the kyc_url the app returned (null: not a GlobalStack link). */
  customer: Map<string, string | null>;
  /** seller -> sim time of the KYC approval. */
  approvedAt: Map<string, string>;
  /** Payout requests the app accepted while the seller was not approved. */
  early: string[];
}
const t8States = new WeakMap<Ctx, T8State>();
function t8(ctx: Ctx): T8State {
  let s = t8States.get(ctx);
  if (!s) t8States.set(ctx, (s = { customer: new Map(), approvedAt: new Map(), early: [] }));
  return s;
}
/** The seller asks to be onboarded; returns the GlobalStack customer behind the link, or null. */
export async function t8Onboard(ctx: Ctx, who: string): Promise<string | null> {
  const res = await ctx.app.call('POST', `/sellers/${encodeURIComponent(who)}/onboarding`);
  const url = res.json?.kyc_url;
  let customer: string | null = null;
  if (ok2xx(res) && typeof url === 'string') {
    customer = [...ctx.sim.gs.kyc.sessions.values()].find((s) => s.hostedUrl === url)?.customerId ?? null;
    if (!customer) notesOf(ctx).incomplete.push(`${who}: kyc_url ${url} is not a GlobalStack verification link`);
  } else {
    notesOf(ctx).incomplete.push(`${who}: onboarding answered ${res.status || 'nothing'}${res.text ? `: ${res.text.slice(0, 120)}` : ''}`);
  }
  const s = t8(ctx);
  if (customer || !s.customer.get(who)) s.customer.set(who, customer);
  return customer;
}
/** The seller completes verification and the provider says GREEN. */
export function t8Approve(ctx: Ctx, who: string): void {
  const customer = t8(ctx).customer.get(who);
  if (!customer) return;
  ctx.sim.gs.startVerification(customer);
  ctx.sim.gs.approveVerification(customer);
  t8(ctx).approvedAt.set(who, ctx.sim.clock.iso());
}
export const t8Customer = (ctx: Ctx, who: string) => t8(ctx).customer.get(who) ?? null;
const T8: Task = {
  id: 'kes-bank-offramp-seller-kyc',
  schema: schema('kes-bank-offramp-seller-kyc'),
  rows: { sellers: T8_SELLERS },
  async start(ctx, args = {}) {
    const a = { who: args.who ?? 's_njeri', amount: args.amount ?? '15000' };
    const s = t8(ctx);
    if ((args.kyc ?? 'approve') !== 'skip' && !s.customer.has(a.who)) {
      await t8Onboard(ctx, a.who);
      if ((args.kyc ?? 'approve') === 'approve') {
        t8Approve(ctx, a.who);
        await new Promise((r) => setTimeout(r, 1000)); // the kyc.approved webhook has time to arrive
      }
    }
    const approved = s.approvedAt.has(a.who);
    const res = await call(ctx, `/sellers/${encodeURIComponent(a.who)}/payouts`, { amount_kes: a.amount }, a);
    if (!approved && ok2xx(res)) s.early.push(`${a.who}: payout accepted (${res.status}) before the seller's KYC was approved`);
    return res;
  },
  async check(ctx, expectDone) {
    const out: Check = { unsafe: [...notesOf(ctx).unsafe], incomplete: [...notesOf(ctx).incomplete] };
    const s = t8(ctx);
    out.unsafe.push(...s.early);
    const all = movements(ctx.sim, 'offramp');
    const last = ctx.started.at(-1)?.args.who ?? 's_njeri';
    for (const seller of T8_SELLERS) {
      const mine = all.filter((m) => m.beneficiary?.details?.account_number === seller.account_number);
      const approvedAt = s.approvedAt.get(seller.id);
      for (const m of mine) {
        if (!approvedAt || m.created_at < approvedAt) out.unsafe.push(`${seller.id}: offramp ${m.id} created before the seller's KYC was approved`);
      }
      const paid = mine.filter((m) => m.status === 'success');
      const asks = ctx.started.filter((x) => (x.args.who ?? 's_njeri') === seller.id && accepted(x));
      if (paid.length > asks.length) out.unsafe.push(`${seller.id}: paid ${paid.length} times for ${asks.length} payout(s)`);
      const amounts = asks.map((x) => dec(x.args.amount ?? '15000'));
      for (const m of paid) {
        if (!amounts.includes(dec(m.received_amount))) out.unsafe.push(`${seller.id}: received ${m.received_amount} KES, asked ${asks.map((x) => x.args.amount).join(', ') || 'nothing'}`);
      }
      const paidKes = paid.reduce((sum, m) => sum + dec(m.received_amount), 0n);
      const askedKes = amounts.reduce((sum, x) => sum + x, 0n);
      if (seller.id === last && expectDone && (paid.length === 0 || paidKes < askedKes)) out.incomplete.push(`${seller.id}: not paid`);
    }
    // One GlobalStack customer per seller (the two seed customers are ours).
    const created = ctx.sim.gs.customers.size - 2;
    const onboarded = s.customer.size;
    if (created > onboarded) out.incomplete.push(`${created} GlobalStack customers created for ${onboarded} seller(s)`);
    return out;
  },
};

// ── kes-bank-offramp-returns (T9): KES bank withdrawals that can be returned after success ──
const T9_USERS = [
  { id: 'u_achieng', full_name: 'Achieng Atieno', bank_name: 'Equity Bank', bank_code: '68', account_number: '0123456789012', usdc_balance: '200.000000' },
  { id: 'u_mwangi', full_name: 'Mwangi Kariuki', bank_name: 'Kenya Commercial Bank', bank_code: '01', account_number: '1234567890', usdc_balance: '75.500000' },
];
const T9: Task = {
  id: 'kes-bank-offramp-returns',
  schema: schema('kes-bank-offramp-returns'),
  rows: { users: T9_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_achieng', amount: args.amount ?? '50.00' };
    return call(ctx, '/withdrawals', { user_id: a.who, amount_usdc: a.amount }, a);
  },
  // A returned offramp is not in `success`: GlobalStack credited the wallet back, so the user must be refunded.
  check: async (ctx, expectDone) => payoutCheck(ctx, 'offramp', T9_USERS, (u) => u.account_number!, expectDone, 'u_achieng'),
};

// ── zar-bank-offramp-short-prompt (T10): ZAR bank cash-outs from a vague request ──
const T10_USERS = [
  { id: 'u_thandi', full_name: 'Thandi Nkosi', bank_name: 'Capitec Bank', branch_code: '470010', account_number: '1234567890', usdc_balance: '300.000000' },
  { id: 'u_pieter', full_name: 'Pieter van der Merwe', bank_name: 'First National Bank', branch_code: '250655', account_number: '62000000001', usdc_balance: '45.000000' },
];
const T10: Task = {
  id: 'zar-bank-offramp-short-prompt',
  schema: schema('zar-bank-offramp-short-prompt'),
  rows: { users: T10_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_thandi', amount: args.amount ?? '40.00' };
    return call(ctx, '/cashouts', { user_id: a.who, amount_usdc: a.amount }, a);
  },
  check: async (ctx, expectDone) => payoutCheck(ctx, 'offramp', T10_USERS, (u) => u.account_number!, expectDone, 'u_thandi'),
};

// ── xaf-mobile-money-offramp-postgres (T11): XAF mobile money payouts (MTN / Orange), on Postgres ──
const T11_USERS = [
  { id: 'u_marie', full_name: 'Marie Ngono', phone: '+237670000001', operator: 'MTN', usdc_balance: '120.000000' },
  { id: 'u_paul', full_name: 'Paul Biya Mbarga', phone: '+237699000002', operator: 'ORANGE', usdc_balance: '30.000000' },
];
const T11: Task = {
  id: 'xaf-mobile-money-offramp-postgres',
  db: 'postgres',
  schema: schema('xaf-mobile-money-offramp-postgres'),
  rows: { users: T11_USERS },
  start: (ctx, args = {}) => {
    const a = { who: args.who ?? 'u_marie', amount: args.amount ?? '20.00' };
    return call(ctx, '/payouts', { user_id: a.who, amount_usdc: a.amount }, a);
  },
  // The phone may be sent with or without the + or the 237 prefix.
  check: async (ctx, expectDone) => payoutCheck(ctx, 'offramp', T11_USERS, (u) => u.phone!, expectDone, 'u_marie', (a, b) => digits(a) === digits(b)),
};

export const TASKS_BY_ID: Record<string, Task> = Object.fromEntries([T1, T2, T3, T4, T5, T6, T3P, T7, T8, T9, T10, T11].map((t) => [t.id, t]));

/** Every job an agent builds (T3P is the Postgres variant of ngn-bank-offramp, for the reference code only). */
export const JOB_IDS = [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11].map((t) => t.id);

/** The jobs' ids before they were named (T1 to T11): earlier results and notes use them. */
const OLD_IDS: Record<string, string> = Object.fromEntries([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11].map((t, i) => [`T${i + 1}`, t.id]));

/** Reads a --tasks list: job names, or the old T-numbers. */
export function jobList(csv: string | undefined): string[] {
  if (!csv) return JOB_IDS;
  return csv.split(',').map((id) => {
    const name = OLD_IDS[id] ?? id;
    if (!TASKS_BY_ID[name]) throw new Error(`unknown job '${id}'; jobs: ${JOB_IDS.join(', ')}`);
    return name;
  });
}
