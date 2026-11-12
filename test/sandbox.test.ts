// The failure sandbox's own guarantees: its report flags what loses money and stays quiet about what does not,
// its controls drive the flows that wait on a payer or a provider, and it covers every route of the real API.
// Run with: node --import tsx --test test/sandbox.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { NOT_SIMULATED, payOnramp, returnMovement, kycVerdict, runningSandbox, sandboxReport, startSandbox, stopSandbox, type Fault } from '../src/sandbox';
import { faultCoverage } from '../src/sandbox/coverage';
import { EVAL_IDS } from '../src/sandbox/sim';

const ROOT = resolve(import.meta.dirname, '..');
process.env.GLOBALSTACK_CATALOG = join(ROOT, 'plugin/skills/globalstack-testing/catalog.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, any>;
let base = '';
let secret = '';

async function start(fault: Fault = 'none') {
  const started = await startSandbox({ app_port: 1, fault });
  base = started.base_url;
  secret = started.secret_key;
}
afterEach(() => stopSandbox());

async function api(method: string, path: string, body?: unknown, key?: string): Promise<Row> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { http: res.status, ...((await res.json()) as Row) };
}

/** An NGN beneficiary of the sandbox's customer. */
async function beneficiary(account = '0123456789'): Promise<string> {
  const providers = await api('GET', '/v1/countries/NG/providers?network=bank');
  const res = await api('POST', '/v1/beneficiaries', {
    type: 'fiat', name: 'Ada Obi', label: 'payout', currency: 'NGN', country_code: 'NG', network: 'bank', provider_id: providers.data[0].id,
    account_number: account, customer_id: EVAL_IDS.treasuryCustomerId, merchant_reference: `ben-${account}`,
  });
  assert.ok(res.http < 300, JSON.stringify(res));
  return res.data.id;
}

/** Quote and execute one NGN payout. Returns the execute's answer. */
async function payout(beneficiaryId: string, reference: string, amount: string): Promise<Row> {
  const quote = await api('POST', '/v1/offramps/quotes', { wallet_id: EVAL_IDS.usdcWalletId, beneficiary_id: beneficiaryId, source_amount: amount }, `${reference}-quote`);
  assert.ok(quote.http < 300, JSON.stringify(quote));
  return api('POST', '/v1/offramps', { quote_id: quote.data.id, reference }, reference);
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}
const finalOf = (id: string) => () => ['success', 'failed', 'returned'].includes(runningSandbox()!.gs.movements.get(id)?.status ?? '');
const warningsMatching = (re: RegExp) => (sandboxReport() as Row).warnings.filter((w: string) => re.test(w));

describe('the report', () => {
  test('a list that no longer includes the final payout does not count as reading it', async () => {
    await start('webhook_silence');
    const ben = await beneficiary();
    const sent = await payout(ben, 'po_list-1', '10.00');
    await until(finalOf(sent.data.id));
    const processing = await api('GET', '/v1/offramps?status=processing');
    assert.equal(processing.data.length, 0);
    assert.equal(warningsMatching(/never read it in that status/).length, 1);
    await api('GET', `/v1/offramps/${sent.data.id}`);
    assert.equal(warningsMatching(/never read it in that status/).length, 0);
  });

  test('a payout refused at execute is neither unknown nor a double payment', async () => {
    await start();
    const ben = await beneficiary();
    const refusedAnswer = await payout(ben, 'po_big-1', '20000.00');
    assert.equal(refusedAnswer.code, 'ledger_insufficient_funds');
    const second = await payout(ben, 'po_big-2', '20.00');
    await until(finalOf(second.data.id));
    await api('GET', `/v1/offramps/${second.data.id}`);
    assert.deepEqual(warningsMatching(/po_big/), []);
  });

  test('separate payouts are not one payment; two attempts of one payment that both go through are', async () => {
    await start();
    const ben = await beneficiary();
    for (const [ref, amount] of [['inv-0041', '10.00'], ['inv-0042', '12.00'], ['wd_7777-1', '15.00'], ['wd_7777-2', '15.00']] as const) {
      if (ref === 'wd_7777-1') assert.deepEqual(warningsMatching(/paid twice/), []);
      assert.equal((await payout(ben, ref, amount)).http, 200);
    }
    const twice = warningsMatching(/paid twice/);
    assert.equal(twice.length, 1);
    assert.match(twice[0], /for one payment "wd_7777"/);
  });

  test('a fault that never happened is not a pass', async () => {
    await start('lost_response');
    const report = sandboxReport() as Row;
    assert.equal(report.fault.fired, false);
    assert.match(report.hints.join(' '), /No execute was sent yet/);
    const run = { started_at: 'a', reported_at: 'b', fault: 'lost_response' as const, movements: 1, warnings: 0, first_warnings: [] };
    assert.equal(faultCoverage([{ ...run, fired: false }]).find((c) => c.fault === 'lost_response')!.status, 'fault_not_triggered');
    assert.equal(faultCoverage([{ ...run, fired: true }]).find((c) => c.fault === 'lost_response')!.status, 'no_warnings');
  });

  test('no webhook endpoint for a flow is a warning that says so', async () => {
    await start();
    const ben = await beneficiary();
    await payout(ben, 'po_hook-1', '10.00');
    assert.equal(warningsMatching(/No webhook endpoint is registered/).length, 1);
    const local = await api('POST', '/v1/notifications/webhooks', { url: 'https://localhost:3000/hooks', event_categories: ['offramp'] }, 'webhook-setup-0');
    assert.equal(local.http, 400); // as in production: no TLD, no webhook
    const ep = await api('POST', '/v1/notifications/webhooks', { url: 'https://merchant-app.sandbox.test/hooks', event_categories: ['offramp'] }, 'webhook-setup-1');
    assert.equal(warningsMatching(/subscribes to offramp but is not active/).length, 1);
    await api('PATCH', `/v1/notifications/webhooks/${ep.data.id}`, { active: true });
    assert.deepEqual(warningsMatching(/webhook endpoint/i), []);
  });

  test('a refused beneficiary names every refused field; an unknown account points at the test accounts', async () => {
    await start();
    const providers = await api('GET', '/v1/countries/NG/providers?network=bank');
    const base = { type: 'fiat', currency: 'NGN', country_code: 'NG', network: 'bank', provider_id: providers.data[0].id, customer_id: EVAL_IDS.treasuryCustomerId };
    const missing = await api('POST', '/v1/beneficiaries', { ...base, account_number: '0123456789', merchant_reference: 'ben-missing' });
    assert.equal(missing.code, 'bad_request');
    assert.deepEqual(missing.data.errors.map((e: Row) => e.field), ['name', 'label']);
    const unknown = await api('POST', '/v1/beneficiaries', { ...base, name: 'Ada Obi', label: 'payout', account_number: '1112223334', merchant_reference: 'ben-unknown' });
    assert.equal(unknown.code, 'account_resolution_failed');
    assert.match((sandboxReport() as Row).hints.join(' '), /only the test accounts resolve: NG bank [^;]*0123456789/);
  });

  test('a real route the sandbox does not simulate answers 501 and is a hint, not a warning', async () => {
    await start();
    const res = await api('PATCH', '/v1/beneficiaries/ben_01M4F0J8Q2T3V5W6X7Y8Z9A0B1', { label: 'x' });
    assert.equal(res.http, 501);
    assert.equal(res.code, 'not_in_sandbox');
    const report = sandboxReport() as Row;
    assert.deepEqual(report.warnings, []);
    assert.match(report.hints.join(' '), /does not simulate it/);
  });
});

describe('the controls', () => {
  test('a bank onramp waits for the payer until pay sends the transfer', async () => {
    await start();
    const quote = await api('POST', '/v1/onramps/quotes', { wallet_id: EVAL_IDS.usdcWalletId, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: '200.00' }, 'zar-quote-1');
    assert.ok(quote.http < 300, JSON.stringify(quote));
    const onramp = await api('POST', '/v1/onramps', { quote_id: quote.data.id, reference: 'zar_fund-1' }, 'zar_fund-1');
    assert.equal(onramp.data.status, 'awaiting_deposit');
    assert.match((sandboxReport() as Row).hints.join(' '), /wait\(s\) for the payer's bank transfer/);
    assert.equal(payOnramp('onr_unknown').ok, false);
    assert.deepEqual((payOnramp() as Row).paid, [onramp.data.id]);
    await until(finalOf(onramp.data.id));
    assert.equal(runningSandbox()!.gs.movements.get(onramp.data.id)!.status, 'success');
  });

  test('return reverses a successful payout and refuses anything else', async () => {
    await start();
    const ben = await beneficiary();
    const sent = await payout(ben, 'po_ret-1', '10.00');
    assert.equal(returnMovement(sent.data.id).ok, false); // still processing
    await until(finalOf(sent.data.id));
    const returned = returnMovement(sent.data.id) as Row;
    assert.equal(returned.ok, true);
    assert.match(returned.effect, /credited 10\.0+ USDC back/);
    assert.equal(runningSandbox()!.gs.movements.get(sent.data.id)!.status, 'returned');
  });

  test('kyc approve needs a verification the app started', async () => {
    await start();
    const customer = await api('POST', '/v1/customers', { type: 'individual', name: 'Ada Obi', email: 'ada@example.com', country_code: 'NG' }, 'customer-ada-1');
    assert.ok(customer.http < 300, JSON.stringify(customer));
    assert.equal((kycVerdict('approve', customer.data.id) as Row).code, 'no_verification');
    const started = await api('POST', `/v1/customers/${customer.data.id}/verifications`, { tier: 'tier_1' }, 'verify-ada-1');
    assert.ok(started.http < 300, JSON.stringify(started));
    assert.equal(kycVerdict('approve', customer.data.id).ok, true);
    assert.equal((await api('GET', `/v1/customers/${customer.data.id}`)).data.kyc_status, 'approved');
  });
});

describe('fidelity', () => {
  test('USDC leaves a wallet in whole cents, as in production', async () => {
    await start();
    const ben = await beneficiary();
    const fine = await api('POST', '/v1/offramps/quotes', { wallet_id: EVAL_IDS.usdcWalletId, beneficiary_id: ben, source_amount: '152.380000' }, 'precision-quote-1');
    assert.equal(fine.http, 200, JSON.stringify(fine));
    const tooFine = await api('POST', '/v1/offramps/quotes', { wallet_id: EVAL_IDS.usdcWalletId, beneficiary_id: ben, source_amount: '152.384211' }, 'precision-quote-2');
    assert.equal(tooFine.code, 'invalid_amount_precision');
  });

  test('every public route of the real API is simulated or answers 501 not_in_sandbox', async () => {
    await start();
    const routes = readFileSync(join(ROOT, 'test/fixtures/public-routes.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const sim = runningSandbox()!;
    const missing = routes.filter((line) => {
      const [method, path] = line.split(' ') as [string, string];
      const sample = path.replace(/\{[^}]+\}/g, 'abc_123');
      return !sim.http.routes.some((r) => r.method === method && r.pattern.test(sample)) && !NOT_SIMULATED.some((p) => p.test(`${method} ${sample}`));
    });
    assert.deepEqual(missing, []);
  });
});

describe('sandbox.mjs', () => {
  const SANDBOX = join(ROOT, 'plugin/skills/globalstack-testing/scripts/sandbox.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gs-sandbox-cli-'));
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [SANDBOX, ...args], { cwd: dir, encoding: 'utf8' })) as Row;
  after(() => {
    try {
      run('stop');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test('the control port needs the token, and stop cleans up', async () => {
    const started = run('start', '--app-port', '3999', '--app-clock');
    assert.equal(started.ok, true);
    assert.match(started.app_clock.node.NODE_OPTIONS, /^--import file:\/\/.+app-clock\.mjs$/);
    const state = JSON.parse(readFileSync(join(dir, '.globalstack-sandbox/state.json'), 'utf8')) as Row;
    assert.equal((await fetch(`http://127.0.0.1:${state.control_port}/report`)).status, 403);
    assert.equal(run('report').ok, true);
    assert.equal(run('advance', '--hours', '1').note.includes("your app's clock"), true);
    assert.equal(run('stop').ok, true);
    await until(() => !existsSync(join(dir, '.globalstack-sandbox/state.json')));
    assert.equal(run('report').code, 'not_running');
  });
});
