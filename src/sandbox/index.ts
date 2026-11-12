// The failure sandbox: one local simulator at a time, armed with one fault, and a report of what it saw.
// It never calls the real GlobalStack API.
import { randomBytes } from 'node:crypto';
import { FAULT_INFO, FAULTS, type Fault, SLOW_FINAL_HOURS } from './faults.ts';
import type { Logged } from './http.ts';
import { EVAL_IDS, Sim } from './sim.ts';

export { FAULT_INFO, FAULTS, type Fault };

/** The https origin the app registers webhooks under. The sandbox delivers it to the app's local port. */
export const PUBLIC_ORIGIN = 'https://merchant-app.sandbox.test';
const EXECUTE = /^POST \/v1\/(offramps|onramps|conversions|transfers)$/;
/** The money write limiter covers offramps, conversions and transfers, not onramps. */
const LIMITED = /^POST \/v1\/(offramps|conversions)(\/quotes)?$|^POST \/v1\/transfers$/;
const MONEY_POST = /^POST \/v1\/(offramps|onramps|conversions)(\/quotes)?$|^POST \/v1\/transfers$/;
const HOUR = 3600_000;
const FINAL = new Set(['success', 'failed', 'returned']);
const MAX_REQUESTS = 200;

/**
 * Routes of the real API (its public OpenAPI) that the sandbox does not simulate. They answer
 * 501 not_in_sandbox, and the report lists them as untested instead of calling them wrong.
 */
export const NOT_SIMULATED = [
  /^PATCH \/v1\/beneficiaries\/[^/]+$/,
  /^DELETE \/v1\/beneficiaries\/[^/]+$/,
  /^PATCH \/v1\/customers\/[^/]+$/,
  /^GET \/v1\/notifications\/webhooks\/[^/]+\/(events|logs)$/,
  /^POST \/v1\/notifications\/webhooks\/[^/]+\/(rotate-secret|send)$/,
  /^PATCH \/v1\/wallets\/[^/]+$/,
];

/** Payout details the sandbox knows. Any other account number fails with account_resolution_failed. */
const TEST_ACCOUNTS = {
  ng_bank_accounts: { '0123456789': 'ADA OBI', '0987654321': 'TUNDE BELLO', '2233445566': 'NGOZI OKAFOR' },
  ke_mpesa_numbers: { '+254712345678': 'WANJIKU KAMAU', '+254722000111': 'OTIENO ODHIAMBO' },
  za_bank_accounts: 'Any digits-only number of the right length for the bank (Capitec 10, FNB 11). Others fail with 400 invalid_input.',
  za_payshap_proxies: { '+27821234567': 'THANDI MOKOENA', 'sipho@capitec': 'SIPHO DLAMINI' },
};

/** What the other commands do. Each acts as GlobalStack, a payer or a provider would. */
const CONTROLS = {
  pay: 'sandbox.mjs pay [onr_...]: the payer sends the bank transfer for a bank onramp (every unpaid one when no id is given).',
  return: 'sandbox.mjs return <id>: GlobalStack reports a successful onramp, offramp or conversion as returned.',
  kyc: "sandbox.mjs kyc approve|reject|start <cust_...> [--retry]: the KYC provider's verdict on the customer's latest verification.",
  deposit: 'sandbox.mjs deposit <address, da_... or wcr_...> <amount>: an on-chain USDC deposit arrives.',
  approve_access: 'sandbox.mjs approve-access <currency> [--country CM]: GlobalStack approves your access request.',
  advance: "sandbox.mjs advance --hours <n>: moves the sandbox clock (and your app's, when it runs with the app clock).",
};

interface Running {
  sim: Sim;
  fault: Fault;
  advancedMs: number;
  /** slow_final: how many movements were held when the clock released them. */
  released: number;
}

let current: Running | null = null;

export interface StartOptions {
  fault?: Fault;
  xaf_access?: 'pending' | 'approved';
  app_port: number;
  /** A file the app clock (scripts/app-clock.mjs) reads: advance then moves the app's clock too. */
  app_clock_file?: string;
}

/** Starts a fresh sandbox, replacing any running one. */
export async function startSandbox({ fault = 'none', xaf_access = 'approved', app_port, app_clock_file }: StartOptions) {
  await stopSandbox();
  const secretKey = `gsa_sk_sandbox_${randomBytes(16).toString('hex')}`;
  const appOrigin = `http://127.0.0.1:${app_port}`;
  const sim = new Sim({ secretKey, xafAccess: xaf_access, publicUrl: { from: PUBLIC_ORIGIN, to: appOrigin }, ...(app_clock_file ? { clockFile: app_clock_file } : {}) });
  sim.http.notSimulated = NOT_SIMULATED;
  if (fault === 'lost_response') sim.faults = { dropResponse: { match: EXECUTE, count: 1 } };
  if (fault === 'rate_limit') sim.faults = { rateLimit: { match: LIMITED, count: 2 } };
  if (fault === 'provider_error') sim.behaviour = { failNextExecutes: 1 };
  if (fault === 'slow_final') sim.behaviour = { holdFinal: true };
  if (fault === 'webhook_silence') sim.delivery = 'silent';
  if (fault === 'webhook_noise') sim.delivery = 'noisy';
  const baseUrl = await sim.listen(0);
  current = { sim, fault, advancedMs: 0, released: 0 };

  return {
    ok: true,
    base_url: baseUrl,
    secret_key: secretKey,
    ids: {
      customer_id: EVAL_IDS.treasuryCustomerId,
      usdc_wallet_id: EVAL_IDS.usdcWalletId,
      ngn_wallet_id: EVAL_IDS.ngnWalletId,
      default_customer_id: EVAL_IDS.defaultCustomerId,
    },
    env: {
      GLOBALSTACK_BASE_URL: baseUrl,
      GLOBALSTACK_SECRET_KEY: secretKey,
      GLOBALSTACK_CUSTOMER_ID: EVAL_IDS.treasuryCustomerId,
      GLOBALSTACK_WALLET_ID: EVAL_IDS.usdcWalletId,
      PUBLIC_URL: PUBLIC_ORIGIN,
      PORT: String(app_port),
    },
    webhooks: {
      public_origin: PUBLIC_ORIGIN,
      delivers_to: appOrigin,
      note: `Register your webhook URL under ${PUBLIC_ORIGIN} (e.g. ${PUBLIC_ORIGIN}/webhooks/globalstack). The sandbox sends ${PUBLIC_ORIGIN}/<path> to ${appOrigin}/<path>, so run your app on port ${app_port}.`,
    },
    fault: { name: fault, ...FAULT_INFO[fault] },
    account: {
      usdc_balance: '10000.00',
      customer: 'The customer above is tier_2 with KYC approved and owns both wallets. Create beneficiaries with this customer_id.',
      new_customers: 'Customers your app creates start at tier_0 with KYC not started. Approve their KYC with sandbox.mjs kyc approve once your app has started a verification.',
      xaf_access: xaf_access,
      test_accounts: TEST_ACCOUNTS,
    },
    controls: CONTROLS,
    next_steps: [
      'Point your app at base_url with secret_key (see env), run it, and drive the flow.',
      'Then run sandbox.mjs report, fix every warning, and check its check_in_app items in your database. Start again with the next fault.',
      'Nothing here touches the real GlobalStack API. Each start resets all data.',
    ],
  };
}

export async function stopSandbox(): Promise<boolean> {
  const running = current;
  current = null;
  if (!running) return false;
  await running.sim.close();
  return true;
}

const NO_SANDBOX = {
  ok: false,
  code: 'no_sandbox',
  developer_message: 'No sandbox is running.',
  next_steps: ['Run sandbox.mjs start first.'],
};

const refused = (code: string, developer_message: string) => ({ ok: false, code, developer_message });

/** Moves the sandbox clock. Under slow_final, held movements finish once the clock has moved far enough. */
export async function advanceSandbox(hours: number) {
  if (!current) return NO_SANDBOX;
  const { sim } = current;
  const processing = () => [...sim.gs.movements.values()].filter((m) => !FINAL.has(m.status)).length;
  const before = processing();
  await sim.jump(hours * HOUR);
  current.advancedMs += hours * HOUR;
  let released = false;
  if (current.fault === 'slow_final' && sim.gs.behaviour.holdFinal && current.advancedMs >= SLOW_FINAL_HOURS * HOUR) {
    current.released = sim.gs.heldCount;
    sim.behaviour = { holdFinal: false };
    sim.gs.finishHeld('success');
    released = true;
  }
  return {
    ok: true,
    sandbox_time: sim.clock.iso(),
    advanced_hours_total: current.advancedMs / HOUR,
    movements_not_final: { before: before, after: processing() },
    ...(current.fault === 'slow_final'
      ? { slow_final: released ? 'Held movements are now final (success). Their webhooks are on the way.' : current.advancedMs >= SLOW_FINAL_HOURS * HOUR ? 'Already released.' : `Movements stay processing until ${SLOW_FINAL_HOURS} hours in total.` }
      : {}),
    note: sim.clock.appFollows
      ? "The sandbox clock and your app's clock (the app clock) moved together: timers due in that time ran."
      : "Only the sandbox clock moved: quote expiries, webhook retries and provider finals. Your app's own clock did not move, so its timers and pollers still run on real time. Start with --app-clock to move both.",
  };
}

/** The payer sends the bank transfer for one bank onramp, or for every unpaid one. */
export function payOnramp(id?: string) {
  if (!current) return NO_SANDBOX;
  const { gs } = current.sim;
  const waiting = [...gs.movements.values()].filter((m) => m.kind === 'onramp' && m.status === 'awaiting_deposit' && m._private.network === 'bank' && !m._private.paid);
  const targets = id ? waiting.filter((m) => m.id === id) : waiting;
  if (!targets.length) {
    return refused('nothing_to_pay', id ? `${id} is not a bank onramp waiting for the payer's transfer.` : "No bank onramp is waiting for the payer's transfer.");
  }
  for (const m of targets) gs.payDeposit(m.id);
  return { ok: true, paid: targets.map((m) => m.id), note: "The payer's transfer arrived: the onramp is processing, then success. Its webhooks are on the way." };
}

/** GlobalStack reports a successful onramp, offramp or conversion as returned. */
export function returnMovement(id: string) {
  if (!current) return NO_SANDBOX;
  const { gs } = current.sim;
  const m = gs.movements.get(id);
  if (!m) return refused('not_found', `No movement ${id} in this sandbox.`);
  if (m.kind === 'transfer') return refused('invalid_input', 'Transfers are never returned.');
  if (m.status !== 'success') return refused('invalid_input', `${id} is ${m.status}. Only a successful movement can be returned.`);
  const reversal = gs.returnMovement(id);
  const effect = {
    offramp: `GlobalStack credited ${m.source_amount} ${m.source_currency} back to the wallet (transaction ${reversal}, source_type offramp_reversal). Your app should undo the payout in its books, once.`,
    conversion: 'Nothing is credited back. Your app should flag it for a human, once, and not refund automatically.',
    onramp: 'No money moves at GlobalStack. Your app should flag it for a human: the user may need to give the USDC back.',
  }[m.kind as 'offramp' | 'conversion' | 'onramp'];
  return { ok: true, returned: id, kind: m.kind, effect, note: `${m.kind}.returned is on the way.` };
}

/** The KYC provider's verdict on the customer's latest verification. */
export function kycVerdict(action: 'approve' | 'reject' | 'start', customerId: string, retry = false) {
  if (!current) return NO_SANDBOX;
  const { gs } = current.sim;
  if (!gs.customers.has(customerId)) return refused('not_found', `No customer ${customerId} in this sandbox.`);
  const session = action === 'approve' ? gs.approveVerification(customerId) : action === 'reject' ? gs.rejectVerification(customerId, { retry }) : gs.startVerification(customerId);
  if (!session) {
    return refused('no_verification', action === 'start'
      ? `Customer ${customerId} has no verification to start, or it is already in progress. Your app starts one with POST /v1/customers/${customerId}/verifications.`
      : `Customer ${customerId} has no verification yet. Your app starts one with POST /v1/customers/${customerId}/verifications.`);
  }
  const note = action === 'approve' ? 'kyc.approved is on the way.' : action === 'reject' && !retry ? 'kyc.rejected is on the way.' : 'No webhook for this step: your app sees it on GET /v1/customers/{id}.';
  return { ok: true, customer_id: customerId, verification: session, note };
}

/** An on-chain USDC deposit arrives at a deposit address or wallet credential. */
export function simulateDeposit(target: string, amount: string) {
  if (!current) return NO_SANDBOX;
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) return refused('invalid_input', 'Give the amount as a decimal string, e.g. 25.00.');
  try {
    const id = current.sim.gs.simulateDeposit(target, amount);
    return { ok: true, transaction_id: id, note: 'deposit.received now, then deposit.confirmed (or deposit.held when the customer is over the tier limit).' };
  } catch (err) {
    return refused('invalid_input', (err as Error).message.replace(/^gs-sim: /, ''));
  }
}

/** GlobalStack approves the access request for a gated currency. */
export function approveAccess(currency: string, country?: string) {
  if (!current) return NO_SANDBOX;
  const { gs } = current.sim;
  if (!gs.currencyRow(currency, country ?? null)) return refused('not_found', `No ${currency}${country ? ` (${country})` : ''} row in this sandbox's catalog.`);
  gs.approveAccess(currency, country ?? null);
  return { ok: true, currency, country_code: country ?? null, has_access: true, note: 'No webhook: your app sees it as has_access true on GET /v1/currencies, and the request as approved on GET /v1/currencies/access-requests.' };
}

type Row = Record<string, any>;

/** "wd_123-2" -> "wd_123": the reference without a one-digit attempt number. "inv-41" stays "inv-41". */
export function attemptPrefix(reference: string): string {
  return reference.replace(/[-_.:][1-9]$/, '');
}

const labelOf = (method: string, path: string) =>
  `${method} ${path.split('?')[0]!.replace(/\/+$/, '').replace(/\/[a-z]+_[0-9A-Z]{26}/g, (m) => '/' + m.slice(1, m.indexOf('_')) + '_')}`;

/** Answers that do not decide anything about the movement: the app still has to find out. */
const NOT_A_REFUSAL = new Set(['duplicate_resource', 'idempotency_in_progress', 'idempotency_conflict', 'rate_limited', 'replayed', 'dropped']);
/** A 4xx that refuses the request itself: the same request gets the same answer. */
const isRefusal = (r: Logged) => r.status >= 400 && r.status < 500 && !NOT_A_REFUSAL.has(r.code);

/** Whether the fault happened in this run, and what to do when it has not. */
function faultFired(run: Running): { fired: boolean; how: string } {
  const { sim, fault } = run;
  const log = sim.http.log;
  const count = (n: number, what: string, otherwise: string) => (n > 0 ? { fired: true, how: `${n} ${what}.` } : { fired: false, how: otherwise });
  switch (fault) {
    case 'none':
      return { fired: true, how: 'No fault to trigger.' };
    case 'lost_response':
      return count(log.filter((r) => r.code === 'dropped').length, 'execute response(s) dropped', 'No execute was sent yet, so no response was dropped. Drive the flow until it executes.');
    case 'provider_error':
      return count(log.filter((r) => EXECUTE.test(labelOf(r.method, r.path)) && r.status === 500).length, 'execute(s) failed at the provider', 'No execute has failed at the provider yet. Drive the flow until it executes. It never fires for a bank onramp.');
    case 'rate_limit':
      return count(log.filter((r) => r.status === 429).length, 'request(s) answered 429', 'No money write was rate limited yet. It covers offramps, conversions and transfers, not onramps.');
    case 'webhook_silence':
      return count(sim.events.events.length, 'event(s) held back', 'No event was due yet. Drive the flow until a movement changes state.');
    case 'webhook_noise':
      return count(sim.events.deliveries.filter((d) => d.forged).length, 'forged event(s) sent', 'No forged event was sent yet: it follows the first processing event. Drive the flow further.');
    case 'slow_final':
      if (run.released) return { fired: true, how: `${run.released} movement(s) were held in processing until the clock moved ${SLOW_FINAL_HOURS} hours.` };
      return sim.gs.heldCount > 0
        ? { fired: false, how: `${sim.gs.heldCount} movement(s) are held in processing. Check your app keeps them pending, then run sandbox.mjs advance --hours ${SLOW_FINAL_HOURS}.` }
        : { fired: false, how: 'No movement reached processing yet. Drive the flow until it executes.' };
  }
}

/** What happened at "GlobalStack" since sandbox_start, with plain warnings derived from it. */
export function sandboxReport() {
  if (!current) return NO_SANDBOX;
  const run = current;
  const { sim, fault } = run;
  const log = sim.http.log;
  const movements = [...sim.gs.movements.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const deliveries = sim.events.deliveries;
  const endpoints = [...sim.events.endpoints.values()];
  const warnings: string[] = [];
  const hints: string[] = [];

  const executes = log.filter((r) => EXECUTE.test(labelOf(r.method, r.path)));
  const executesFor = (m: Row) =>
    executes.filter((r) => {
      const b = (r.body ?? {}) as Row;
      return (typeof b.reference === 'string' && b.reference === m.reference) || (typeof b.quote_id === 'string' && b.quote_id === m.quote_id);
    });
  // An execute refused with a 4xx (insufficient funds...) told the app the outcome in its own response.
  const refusedAtExecute = (m: Row) => executesFor(m).some(isRefusal);
  const covers = (kind: string) => endpoints.some((e) => e.active && e.event_categories.includes(kind as never));
  const targetOf = (m: Row): { key: string; label: string } | null => {
    if (m.kind === 'conversion') return m.destination_wallet?.id ? { key: `${m.source_wallet?.id}>${m.destination_wallet.id}`, label: `wallet ${m.destination_wallet.id}` } : null;
    if (m.kind === 'onramp') return m.wallet?.id ? { key: `${m.wallet.id}:${m._private?.phone ?? ''}`, label: `wallet ${m.wallet.id}${m._private?.phone ? ` from ${m._private.phone}` : ''}` } : null;
    return m.beneficiary?.id ? { key: m.beneficiary.id, label: `beneficiary ${m.beneficiary.id}` } : null;
  };
  const sameAmount = (a: Row, b: Row) =>
    a.kind === 'transfer' ? a.amount === b.amount : a.source_amount === b.source_amount || (a.destination_amount != null && a.destination_amount === b.destination_amount);
  const describe = (m: Row) => `${m.id} ${m.reference} ${m.status}`;

  // 1. Money that went out (or came in) twice: movements that did not fail, for one payment or one target and amount.
  const live = movements.filter((m) => m.status !== 'failed' && !refusedAtExecute(m) && typeof m.reference === 'string');
  const byPayment = new Map<string, Row[]>();
  for (const m of live) {
    const target = targetOf(m);
    if (!target) continue;
    const key = `${m.kind}|${attemptPrefix(m.reference)}|${target.key}`;
    byPayment.set(key, [...(byPayment.get(key) ?? []), m]);
  }
  for (const list of byPayment.values()) {
    if (list.length < 2) continue;
    const first = list[0]!;
    warnings.push(
      `${list.length} ${first.kind}s went through for one payment "${attemptPrefix(first.reference)}" to ${targetOf(first)!.label}: ${list.map(describe).join(', ')}. ` +
        'The user was paid twice. Before a new attempt, look the previous one up by reference, and start it only once that one has failed.',
    );
  }
  const byTarget = new Map<string, Row[]>();
  for (const m of live) {
    const target = targetOf(m);
    if (target) byTarget.set(`${m.kind}|${target.key}`, [...(byTarget.get(`${m.kind}|${target.key}`) ?? []), m]);
  }
  for (const list of byTarget.values()) {
    const twins = list.filter((a) => list.some((b) => b !== a && attemptPrefix(b.reference) !== attemptPrefix(a.reference) && sameAmount(a, b)));
    if (twins.length < 2) continue;
    warnings.push(
      `${twins.length} ${twins[0]!.kind}s with different references went to ${targetOf(twins[0]!)!.label} for the same amount: ${twins.map(describe).join(', ')}. ` +
        'If they come from one user request, the user was paid twice: a retry must reuse the reference of the attempt it repeats.',
    );
  }

  // 2. Executes: the same quote sent again after it was refused, and money POSTs without an Idempotency-Key.
  const lastByQuote = new Map<string, Logged>();
  for (const r of executes) {
    const quoteId = (r.body as Row | null)?.quote_id;
    if (typeof quoteId !== 'string') continue;
    const prev = lastByQuote.get(quoteId);
    if (prev && isRefusal(prev)) {
      warnings.push(`${labelOf(r.method, r.path)} was sent again with quote_id ${quoteId} after it was refused with ${prev.status} ${prev.code}. A refused request gets the same answer again: look the movement up by reference, then start a new attempt with a new quote.`);
    }
    lastByQuote.set(quoteId, r);
  }
  const noKey = log.filter((r) => MONEY_POST.test(labelOf(r.method, r.path)) && !r.idempotencyKey);
  for (const label of new Set(noKey.map((r) => labelOf(r.method, r.path)))) {
    warnings.push(`${label} was sent ${noKey.filter((r) => labelOf(r.method, r.path) === label).length} time(s) without an Idempotency-Key header.`);
  }

  // 3. Rate limits never retried, wrong key, unknown routes.
  log.forEach((r, i) => {
    if (r.status !== 429) return;
    const label = labelOf(r.method, r.path);
    if (!log.slice(i + 1).some((later) => labelOf(later.method, later.path) === label)) {
      warnings.push(`${label} answered 429 rate_limited at ${r.at} and was never sent again.`);
    }
  });
  const unauthorized = log.filter((r) => r.status === 401).length;
  if (unauthorized) warnings.push(`${unauthorized} request(s) answered 401: wrong or missing secret key.`);
  for (const label of new Set(log.filter((r) => r.status === 403 && r.code === 'forbidden').map((r) => labelOf(r.method, r.path)))) {
    warnings.push(`${label} answered 403 forbidden: the API has no such route.`);
  }
  for (const label of new Set(log.filter((r) => r.code === 'not_in_sandbox').map((r) => labelOf(r.method, r.path)))) {
    hints.push(`${label} exists in the GlobalStack API, but this sandbox does not simulate it (it answered 501). Test that call against the docs.`);
  }
  if (log.some((r) => r.code === 'account_resolution_failed')) {
    hints.push('An account could not be verified (account_resolution_failed). In this sandbox only the test accounts resolve: ' +
      `NG bank ${Object.keys(TEST_ACCOUNTS.ng_bank_accounts).join(', ')}; KE M-Pesa ${Object.keys(TEST_ACCOUNTS.ke_mpesa_numbers).join(', ')}; ` +
      `ZA PayShap ${Object.keys(TEST_ACCOUNTS.za_payshap_proxies).join(', ')}. Your app should tell the user to check the details.`);
  }

  // 4. Webhooks: no endpoint for a flow, forged events accepted, real events never acknowledged.
  for (const kind of new Set(movements.filter((m) => !refusedAtExecute(m)).map((m) => m.kind as string))) {
    if (covers(kind)) continue;
    const subscribed = endpoints.filter((e) => e.event_categories.includes(kind as never));
    warnings.push(
      subscribed.length
        ? `Your webhook endpoint ${subscribed.map((e) => e.id).join(', ')} subscribes to ${kind} but is not active, so GlobalStack sends it nothing. Activate it with PATCH /v1/notifications/webhooks/{id} and {"active": true}.`
        : endpoints.length
          ? `No webhook endpoint subscribes to ${kind} (yours: ${endpoints.map((e) => `${e.id} [${e.event_categories.join(', ')}]`).join('; ')}), so GlobalStack will not tell your app when a ${kind} ends.`
          : `No webhook endpoint is registered, so GlobalStack will not tell your app when a ${kind} ends. Register one under ${PUBLIC_ORIGIN} and activate it.`,
    );
  }
  for (const d of deliveries.filter((x) => x.forged && x.status >= 200 && x.status < 300)) {
    warnings.push(`Forged webhook ${d.eventId} (${d.type}, bad signature) answered ${d.status}. It should be rejected with 4xx.`);
  }
  const realByEvent = new Map<string, typeof deliveries>();
  for (const d of deliveries.filter((x) => !x.forged)) realByEvent.set(d.eventId, [...(realByEvent.get(d.eventId) ?? []), d]);
  for (const [eventId, list] of realByEvent) {
    if (list.some((d) => d.status >= 200 && d.status < 300)) continue;
    const last = list.at(-1)!;
    warnings.push(
      `Correctly signed webhook ${eventId} (${last.type}) was delivered ${list.length} time(s) and never answered 2xx (last: ${last.status === 0 ? 'no answer, connection failed' : last.status}).`,
    );
  }

  // 5. A final movement the app never learned about: no 2xx on its final event, and never read in its final status.
  for (const m of movements.filter((x) => FINAL.has(x.status) && !refusedAtExecute(x))) {
    const finalEvents = sim.events.events.filter((e) => e.type === `${m.kind}.${m.status}` && (e.payload.event_object as Row)?.id === m.id);
    const acked = deliveries.some((d) => !d.forged && d.status >= 200 && d.status < 300 && finalEvents.some((e) => e.id === d.eventId));
    const read = log.some((r) => r.method === 'GET' && r.seen?.some((s) => s.id === m.id && s.status === m.status));
    if (acked || read) continue;
    const why = executesFor(m).some((r) => r.status >= 500)
      ? 'its execute answered 5xx and GlobalStack sends no webhook for that'
      : !covers(m.kind) ? `no active webhook endpoint covers ${m.kind} events`
      : sim.events.mode === 'silent' ? 'webhooks were silent (the fault)'
      : 'its final webhook was never answered 2xx';
    warnings.push(`${m.kind} ${m.id} (${m.reference}) is ${m.status} at GlobalStack since ${m.updated_at}, but ${why}, and your app never read it in that status (GET /v1/${m.kind}s/${m.id}, or a list that includes it).`);
  }

  // 6. An execute that failed at the provider and was never tried again: the user's payment silently stops.
  log.forEach((r, i) => {
    if (r.method !== 'POST' || !EXECUTE.test(labelOf(r.method, r.path)) || r.status < 500) return;
    const path = r.path.split('?')[0];
    // A retry is a later successful execute for the same payment: the same attempt prefix (or, for transfers, the same beneficiary and amount).
    const body = (r.body ?? {}) as Row;
    const sameRecord = (later: Logged) => {
      const b = (later.body ?? {}) as Row;
      if (typeof body.reference === 'string' && typeof b.reference === 'string' && attemptPrefix(b.reference) === attemptPrefix(body.reference)) return true;
      return typeof body.beneficiary_id === 'string' && b.beneficiary_id === body.beneficiary_id && b.amount === body.amount;
    };
    if (log.slice(i + 1).some((later) => later.method === 'POST' && later.path.split('?')[0] === path && later.status < 300 && sameRecord(later))) return;
    warnings.push(
      `${r.method} ${path} answered ${r.status} ${r.code} at ${r.at}, and your app never executed again. A provider error is temporary: look the movement up by reference, then retry automatically with the next attempt number (and a new quote if the flow uses one). Fail and refund only after the last attempt.`,
    );
  });

  // Hints: what the run is waiting for.
  const unpaid = movements.filter((m) => m.kind === 'onramp' && m.status === 'awaiting_deposit' && m._private?.network === 'bank' && !m._private?.paid);
  if (unpaid.length) hints.push(`${unpaid.map((m) => m.id).join(', ')} wait(s) for the payer's bank transfer. Run sandbox.mjs pay to send it.`);
  const fired = faultFired(run);
  if (!fired.fired) hints.push(fired.how);

  const counts: Record<string, number> = {};
  for (const m of movements) counts[`${m.kind}_${m.status}`] = (counts[`${m.kind}_${m.status}`] ?? 0) + 1;
  const requests = log.slice(-MAX_REQUESTS).map((r) => {
    const body = (r.body ?? {}) as Row;
    return {
      at: r.at,
      method: r.method,
      path: r.path,
      status: r.status,
      code: r.code === 'dropped' ? 'dropped (ran at GlobalStack; the response never reached your app)' : r.code,
      idempotency_key: r.idempotencyKey,
      ...(typeof body.reference === 'string' ? { reference: body.reference } : {}),
      ...(typeof body.quote_id === 'string' ? { quote_id: body.quote_id } : {}),
    };
  });

  return {
    ok: true,
    fault: { name: fault, ...FAULT_INFO[fault], fired: fired.fired, how: fired.how },
    sandbox_time: sim.clock.iso(),
    summary: {
      requests: log.length,
      movements: counts,
      webhook_deliveries: deliveries.length,
      warnings: warnings.length,
    },
    warnings,
    hints,
    check_in_app: FAULT_INFO[fault].check_in_app,
    note: 'No warnings means the sandbox saw nothing wrong in your API calls and webhook answers. It cannot see your database: check each check_in_app item there too.',
    movements: movements.map((m) => ({
      id: m.id,
      kind: m.kind,
      status: m.status,
      reference: m.reference ?? null,
      quote_id: m.quote_id ?? null,
      ...(m.kind === 'transfer'
        ? { amount: m.amount, currency: m.currency }
        : { source_amount: m.source_amount, source_currency: m.source_currency, destination_amount: m.destination_amount, destination_currency: m.destination_currency, received_amount: m.received_amount ?? null }),
      beneficiary_id: m.beneficiary?.id ?? null,
      failure_reason: m.failure_reason ?? null,
      created_at: m.created_at,
      updated_at: m.updated_at,
    })),
    webhook_endpoints: endpoints.map((e) => ({ id: e.id, url: e.url, active: e.active, event_categories: e.event_categories })),
    webhook_deliveries: deliveries.map((d) => ({ at: d.at, event_id: d.eventId, type: d.type, attempt: d.attempt + 1, forged: d.forged, app_status: d.status })),
    requests,
    ...(log.length > MAX_REQUESTS ? { requests_note: `Only the last ${MAX_REQUESTS} of ${log.length} requests are listed.` } : {}),
  };
}

/** For tests: the running simulator. */
export function runningSandbox(): Sim | null {
  return current?.sim ?? null;
}
