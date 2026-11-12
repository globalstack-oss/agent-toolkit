// The /v1 endpoints gs-sim serves, and the money engine behind them.
// Behaviour follows the live API. The API source lines and spec sections behind each rule are cited in this file at
// commit 5ea09fa (plugin 0.2.1); shipped code no longer names them.
import {
  ApiError, badRequest, refusedFields, div, divUp, formatAmount, mul, newId, notFound, parseAmount, roundDown, roundUp, units, type Clock, type Units,
} from './core.ts';
import { CATEGORIES, type Category, type Events } from './events.ts';
import { paginate, type Reply, type Request, type SimHttp } from './http.ts';
import { Kyc } from './kyc.ts';
import { PayIns, CUSTOMER_KYC_NEXT_STEPS_ACTION, type DepositOptions } from './payins.ts';

/** The API's webhook URL check: https only, with the protocol written out, and a host with a TLD. */
const httpsUrl = (url: unknown): boolean => {
  try {
    const { protocol, hostname } = new URL(String(url));
    return typeof url === 'string' && protocol === 'https:' && hostname.includes('.');
  } catch {
    return false;
  }
};

// ── Seed: the account the simulator starts from ──────────────────────────────
export interface CurrencyRow {
  code: string;
  name: string;
  type: 'fiat' | 'crypto';
  precision: number;
  country_code?: string;
  can_onramp: boolean;
  can_offramp: boolean;
  can_transfer: boolean;
  can_deposit: boolean;
  can_convert: boolean;
  requires_access: boolean;
  networks: Array<{ network: string; inbound: { min: string; max: string }; outbound: { min: string; max: string } }>;
  fees?: unknown;
  created_at: string;
  updated_at: string;
}

export interface Seed {
  integrationId: string;
  developerId: string;
  role: string;
  defaultCustomerId: string;
  customers: Array<Record<string, any>>;
  wallets: Array<{ id: string; customer_id: string; currency: string; label?: string; available: string }>;
  currencies: CurrencyRow[];
  countries: Array<{ code: string; name: string; currencies: string[]; networks: string[] }>;
  providers: Record<string, Array<{ id: string; name: string; code: string; network: string; active: boolean }>>;
  accessRequests: Array<{ code: string; country_code: string | null; status: 'pending' | 'approved' | 'rejected' }>;
  /** Local currency per 1 USDC. */
  rates: Record<string, string>;
  /** Accounts the payout providers know: provider code + account number (or phone) -> holder name. */
  knownAccounts: Record<string, string>;
}

/** Scenario knobs the grader sets. */
export interface Behaviour {
  /** Simulated ms between provider events. */
  stepMs: number;
  /** Movements stay `processing` until the grader calls finishHeld(). */
  holdFinal: boolean;
  /** The next N executes fail at the provider: the row is stored `failed` and the call answers 500. */
  failNextExecutes: number;
  /** Mobile money payers approve the prompt (true) or never do (false). */
  payerApproves: boolean;
  /** Money-in caps per tier are enforced, as in production. */
  tierEnforcement: boolean;
  /** Rolling-30-day money-in cap in USD per tier; a tier with no entry has no cap. */
  tierCapsUsd: { tier_1?: string; tier_2?: string };
}

type Kind = 'onramp' | 'offramp' | 'conversion' | 'transfer';
type Movement = Record<string, any> & { id: string; kind: Kind; status: string; _private: Record<string, any> };

const FINAL = new Set(['success', 'failed', 'returned']);
/** The status values each list accepts; offramps and conversions share one set. */
const LIST_STATUSES = {
  onramp: ['created', 'awaiting_deposit', 'processing', 'temporary_failure', 'success', 'failed', 'returned'],
  offramp: ['created', 'processing', 'temporary_failure', 'success', 'failed', 'returned'],
  transfer: ['processing', 'temporary_failure', 'success', 'failed'],
};
const PREFIX: Record<Kind, string> = { onramp: 'onr', offramp: 'ofr', conversion: 'con', transfer: 'tfr' };
/** Quote life per corridor. */
const QUOTE_TTL_MS: Record<string, number> = { NGN: 30 * 60_000, ZAR: 30 * 60_000, KES: 60 * 60_000, XAF: 60 * 60_000, GHS: 1000_000 };
/** Unfunded conversions fail this long after the quote. */
const UNFUNDED_FAIL_MS: Record<string, number> = { NGN: 35 * 60_000, ZAR: 35 * 60_000, KES: 65 * 60_000, XAF: 65 * 60_000, GHS: 35 * 60_000 };
const ID = (prefix: string) => new RegExp(`^${prefix}_`);
/** Source amount limits per currency, enforced at quote time. */
const FX_LIMITS: Record<string, [string, string]> = {
  USDC: ['2.5', '1000000'], NGN: ['4500', '30000000'], ZAR: ['50', '2000000'], GHS: ['50', '2000000'], KES: ['330', '250000'],
};

export class GlobalStack {
  readonly seed: Seed;
  readonly clock: Clock;
  readonly events: Events;
  behaviour: Behaviour = { stepMs: 500, holdFinal: false, failNextExecutes: 0, payerApproves: true, tierEnforcement: true, tierCapsUsd: { tier_1: '1000000', tier_2: '1000000' } };
  readonly customers = new Map<string, Record<string, any>>();
  readonly wallets = new Map<string, { id: string; customer_id: string; currency: string; label: string | null; available: Units; pending: Units; created_at: string; updated_at: string }>();
  readonly beneficiaries = new Map<string, Record<string, any>>();
  readonly quotes = new Map<string, Record<string, any>>();
  readonly movements = new Map<string, Movement>();
  readonly accessRequests: Array<Record<string, any>> = [];
  readonly deposits: Array<Record<string, any>> = [];
  private readonly held = new Set<string>();
  /** Wallet credentials, deposit addresses, inbound deposits and the tier cap. */
  readonly payins: PayIns;
  /** Verification sessions and verdicts. */
  readonly kyc: Kyc;

  constructor(seed: Seed, clock: Clock, events: Events) {
    this.seed = seed;
    this.clock = clock;
    this.events = events;
    this.payins = new PayIns(this);
    this.kyc = new Kyc(this);
    const now = clock.iso();
    for (const c of seed.customers) this.customers.set(c.id, { created_at: now, updated_at: now, metadata: {}, ...c });
    for (const w of seed.wallets) {
      this.wallets.set(w.id, { id: w.id, customer_id: w.customer_id, currency: w.currency, label: w.label ?? null, available: units(w.available), pending: 0n, created_at: now, updated_at: now });
    }
    for (const r of seed.accessRequests) this.addAccessRequest(r.code, r.country_code, r.status);
  }

  // ── Helpers ──
  private precision(code: string): number {
    return this.seed.currencies.find((c) => c.code === code)?.precision ?? 2;
  }

  private fmt(amount: Units, code: string): string {
    return formatAmount(amount, this.precision(code));
  }

  currencyRow(code: string, country?: string | null): CurrencyRow | undefined {
    return this.seed.currencies.find((c) => c.code === code && (!country || !c.country_code || c.country_code === country));
  }

  hasAccess(code: string, country: string | null | undefined): boolean {
    return this.accessRequests.some((r) => r.resource_code === code && r.status === 'approved' && (!r.country_code || !country || r.country_code === country));
  }

  requireAccess(row: CurrencyRow, country?: string | null): void {
    if (row.requires_access && !this.hasAccess(row.code, country ?? row.country_code)) {
      throw new ApiError(403, 'resource_access_required', `Access to currency '${row.code}' requires approval`, [
        `Request access with POST /v1/currencies/${row.code}/access-requests`,
      ]);
    }
  }

  private customerView(id: string) {
    const c = this.customers.get(id)!;
    return { id: c.id, type: c.type, name: c.name, email: c.email, tier: c.tier, created_at: c.created_at, updated_at: c.updated_at };
  }

  walletRef(id: string) {
    const w = this.wallets.get(id)!;
    return { id: w.id, currency: w.currency, label: w.label };
  }

  walletView(id: string) {
    const w = this.wallets.get(id)!;
    return {
      id: w.id,
      customer_id: w.customer_id,
      customer: this.customerView(w.customer_id),
      currency: w.currency,
      country_code: null,
      label: w.label,
      type: 'custodial',
      destination_address: null,
      available_balance: this.fmt(w.available, w.currency),
      pending_balance: this.fmt(w.pending, w.currency),
      total_balance: this.fmt(w.available + w.pending, w.currency),
      metadata: {},
      provisioned: true,
      created_at: w.created_at,
      updated_at: w.updated_at,
    };
  }

  private addAccessRequest(code: string, country: string | null, status: string): Record<string, any> {
    const now = this.clock.iso();
    const row = this.currencyRow(code, country);
    const request = {
      id: newId('rar', this.clock.now()),
      resource_type: 'currency',
      resource_id: `cur_${code}`,
      resource_code: code,
      country_code: country ?? row?.country_code ?? null,
      merchant_id: this.seed.integrationId,
      merchant_name: 'Eval Merchant',
      status,
      reason: null,
      reviewer_id: null,
      review_reason: null,
      reviewed_at: status === 'pending' ? null : now,
      created_at: now,
      updated_at: now,
    };
    this.accessRequests.push(request);
    return request;
  }

  // ── Grader controls ──
  approveAccess(code: string, country: string | null): void {
    for (const r of this.accessRequests) if (r.resource_code === code && (!country || r.country_code === country)) {
      r.status = 'approved';
      r.reviewed_at = this.clock.iso();
    }
    if (!this.hasAccess(code, country)) this.addAccessRequest(code, country, 'approved');
  }

  setCapability(code: string, country: string | null, field: 'can_onramp' | 'can_offramp', value: boolean): void {
    const row = this.currencyRow(code, country);
    if (row) row[field] = value;
  }

  // ── Grader controls: deposits ──
  /**
   * An inbound on-chain USDC deposit to a credential or deposit address, named by its address or its wcr_/da_ id.
   * Returns the deposit's txn_ id. Default flow: deposit.received now (pending_balance), then after stepMs
   * deposit.confirmed (available_balance) or deposit.held (over the tier cap, or the pay-in is disabled).
   */
  simulateDeposit(target: string, amount: string, options: DepositOptions = {}): string {
    return this.payins.inbound(this.payins.resolveTarget(target), amount, options);
  }

  /** Sends the provider's `completed` for a deposit started with `flow: 'manual'`. */
  confirmDeposit(txnId: string): void {
    this.payins.confirmDeposit(txnId);
  }

  /** Ops voids a deposit's inflight credit; its `completed` then ends in deposit.failed (hold_voided). */
  voidDepositHold(txnId: string): void {
    this.payins.voidDepositHold(txnId);
  }

  /** Releases a tier-held deposit (the manual admin path): available balance, deposit.confirmed. */
  releaseHeldDeposit(txnId: string): void {
    this.payins.releaseHeldDeposit(txnId);
  }

  // ── Grader controls: KYC ──
  /** The customer opened the hosted link: session and customer `in_progress`. No webhook. */
  startVerification(customerId: string): Record<string, unknown> | null {
    return this.kyc.startVerification(customerId);
  }

  /** GREEN verdict on the customer's latest session: approved, tier raised, kyc.approved. */
  approveVerification(customerId: string, snapshot?: Parameters<Kyc['approveVerification']>[1]): Record<string, unknown> | null {
    return this.kyc.approveVerification(customerId, snapshot);
  }

  /** RED verdict: final (rejected, kyc.rejected) or `retry: true` (pending, no webhook). */
  rejectVerification(customerId: string, options?: { reason?: string; retry?: boolean }): Record<string, unknown> | null {
    return this.kyc.rejectVerification(customerId, options);
  }

  // ── Grader controls: returned after success ──
  /**
   * The provider reports `returned` for a successful onramp, offramp or conversion. The row moves to `returned` and `*.returned`
   * is delivered. Offramp: the source amount comes back to the source wallet as an `offramp_reversal` deposit row
   * (no webhook). Conversion: no credit. Onramp: no ledger effect. A fiat-source conversion's webhook is not
   * delivered (the hold cancel fails after commit). Returns the reversal txn_ id for an offramp, else null.
   */
  returnMovement(id: string): string | null {
    const m = this.movements.get(id);
    if (!m || m.kind === 'transfer') throw new Error(`gs-sim: ${id} is not an onramp, offramp or conversion`);
    if (m.status !== 'success') throw new Error(`gs-sim: ${id} is '${m.status}', returnMovement needs 'success'`);
    let reversalId: string | null = null;
    if (m.kind === 'offramp') reversalId = this.creditReturnedOfframp(m);
    const silent = m.kind === 'conversion' && m.source_currency !== 'USDC';
    this.fxEvent(m, 'returned', undefined, silent);
    return reversalId;
  }

  /** The reversal credit of a returned offramp whose debit settled. */
  private creditReturnedOfframp(m: Movement): string {
    const now = this.clock.iso();
    const w = this.wallets.get(m._private.sourceWalletId)!;
    const amount = units(m.source_amount);
    w.available += amount;
    w.updated_at = now;
    const parent = `txn_${m.id.slice(4)}`;
    const row: Record<string, any> = {
      id: newId('txn', this.clock.now()), reference: `${m.id}_reversal`, source_type: 'offramp_reversal', source_id: m.id, transaction_hash: null,
      customer_id: m.customer?.id, from_wallet_id: null, to_wallet_id: w.id, type: 'deposit', status: 'confirmed',
      source_amount: m.source_amount, source_currency: m.source_currency, destination_amount: m.source_amount, destination_currency: m.source_currency,
      confirmed_at: now, metadata: { offramp_external_id: m.id, transfer_external_id: m.metadata?.transfer_external_id ?? null }, created_at: now, updated_at: now,
      parent_transaction_id: parent, root_transaction_id: parent,
    };
    this.deposits.push(row);
    return row.id;
  }

  /** The payer sends the money for a bank onramp (provider states: funds_received, processing, completed). */
  payDeposit(onrampId: string): void {
    const m = this.movements.get(onrampId);
    if (!m || m.kind !== 'onramp' || m.status !== 'awaiting_deposit') return;
    m._private.paid = true;
    // The provider sends `processing` when it sees the deposit, then `completed`.
    this.fxEvent(m, 'processing');
    this.clock.after(this.behaviour.stepMs, () => this.settle(m));
  }

  /** How many movements slow_final is holding in `processing`. */
  get heldCount(): number {
    return this.held.size;
  }

  /** Releases movements held in `processing` to their final state. */
  finishHeld(status: 'success' | 'failed' = 'success'): void {
    for (const id of this.held) {
      const m = this.movements.get(id);
      if (m && !FINAL.has(m.status)) status === 'success' ? this.complete(m) : this.fxEvent(m, 'failed');
    }
    this.held.clear();
  }

  /** True when nothing is waiting on the provider (an unpaid bank onramp waits on the payer, not us). */
  allFinal(): boolean {
    return [...this.movements.values()].every((m) => FINAL.has(m.status) || (m.status === 'awaiting_deposit' && !m._private.paid && m._private.network === 'bank'));
  }

  // ── Lifecycle ──
  private view(m: Movement): Record<string, unknown> {
    const { kind: _kind, _private: _p, ...rest } = m;
    return rest;
  }

  /** The webhook's event_object: the REST resource plus actual_* and terminal fields. */
  private eventObject(m: Movement): Record<string, unknown> {
    const view = this.view(m);
    const terminal = FINAL.has(m.status);
    const extra: Record<string, unknown> = { terminal_at: terminal ? m.updated_at : null, transaction: { id: `txn_${m.id.slice(4)}`, parent_transaction_id: null, root_transaction_id: null } };
    if (m.kind !== 'transfer') {
      Object.assign(extra, {
        actual_source_amount: null,
        // Stored on completion and kept by a later `returned`.
        actual_destination_amount: m.status === 'success' || m.status === 'returned' ? m.received_amount : null,
        actual_rate: m.status === 'success' || m.status === 'returned' ? m.rate : null,
      });
    }
    return { ...view, ...extra };
  }

  /**
   * Applies one provider event. The DB moves forward only; the webhook goes out either way, with the
   * mapped status of this event.
   */
  private fxEvent(m: Movement, fx: 'created' | 'funds_received' | 'processing' | 'completed' | 'failed' | 'returned', failureReason?: string, silent = false): void {
    const map: Record<Kind, Record<string, { status: string; from: string[]; topic: string }>> = {
      onramp: {
        created: { status: 'awaiting_deposit', from: [], topic: 'onramp.awaiting_deposit' },
        funds_received: { status: 'processing', from: ['awaiting_deposit'], topic: 'onramp.funds_received' },
        processing: { status: 'processing', from: ['awaiting_deposit'], topic: 'onramp.processing' },
        completed: { status: 'success', from: ['processing'], topic: 'onramp.success' },
        failed: { status: 'failed', from: ['awaiting_deposit', 'processing'], topic: 'onramp.failed' },
        returned: { status: 'returned', from: ['processing', 'success'], topic: 'onramp.returned' },
      },
      offramp: {
        // `created` comes once the provider sees the funding: already stale, still delivered.
        created: { status: 'created', from: [], topic: 'offramp.created' },
        processing: { status: 'processing', from: [], topic: 'offramp.processing' },
        completed: { status: 'success', from: ['processing'], topic: 'offramp.success' },
        failed: { status: 'failed', from: ['processing'], topic: 'offramp.failed' },
        returned: { status: 'returned', from: ['processing', 'success'], topic: 'offramp.returned' },
      },
      conversion: {
        created: { status: 'created', from: [], topic: 'conversion.created' },
        processing: { status: 'processing', from: [], topic: 'conversion.processing' },
        completed: { status: 'success', from: ['processing'], topic: 'conversion.success' },
        failed: { status: 'failed', from: ['processing'], topic: 'conversion.failed' },
        returned: { status: 'returned', from: ['processing', 'success'], topic: 'conversion.returned' },
      },
      transfer: {
        processing: { status: 'processing', from: [], topic: 'transfer.processing' },
        completed: { status: 'success', from: ['processing'], topic: 'transfer.success' },
        failed: { status: 'failed', from: ['processing'], topic: 'transfer.failed' },
      },
    };
    const rule = map[m.kind][fx];
    if (!rule) return;
    const before = m.status;
    let changes: { status: [string, string] } | null = null;
    if (rule.from.includes(m.status)) {
      m.status = rule.status;
      m.updated_at = this.clock.iso();
      if (rule.status === 'failed') {
        m.failure_reason = failureReason ?? 'failed';
        m.failure_reason_message = failureReason === 'quote_expired' ? 'Payment was not received before the quote expired.' : 'The payment failed at the provider.';
        this.release(m);
      }
      if (rule.status === 'returned') {
        // The message promises no credit.
        m.failure_reason = 'returned';
        m.failure_reason_message = 'This transaction was returned; any funds debited for it have been released.';
      }
      changes = { status: [before, rule.status] };
    }
    if (silent) return;
    const object = { ...this.eventObject(m), status: rule.status };
    const event = this.events.emit(rule.topic, object, changes);
    if (fx === 'processing') m._private.processingEvent = event;
    // Noisy delivery: the stale `processing` event arrives again after the final one.
    if (FINAL.has(rule.status) && this.events.mode === 'noisy' && m._private.processingEvent) {
      const stale = m._private.processingEvent;
      this.clock.after(300, () => this.events.replay(stale));
    }
  }

  /** Releases a hold on the source wallet. */
  private release(m: Movement): void {
    if (!m._private.held) return;
    const w = this.wallets.get(m._private.sourceWalletId)!;
    w.pending -= m._private.held;
    w.available += m._private.held;
    m._private.held = 0n;
  }

  /** After execute: the provider's events in order, then the final state (or the scenario holds it). */
  private progress(m: Movement): void {
    const step = this.behaviour.stepMs;
    const sequence: Array<'created' | 'funds_received' | 'processing'> =
      m.kind === 'onramp' ? ['funds_received', 'processing'] : m.kind === 'transfer' ? ['processing'] : ['created', 'processing'];
    sequence.forEach((fx, i) => this.clock.after((i + 1) * step, () => this.fxEvent(m, fx)));
    this.clock.after((sequence.length + 1) * step, () => this.settle(m));
  }

  private settle(m: Movement): void {
    if (FINAL.has(m.status)) return;
    if (this.behaviour.holdFinal) {
      this.held.add(m.id);
      return;
    }
    if (m.kind === 'onramp' && m._private.network === 'mobile_money' && !this.behaviour.payerApproves) return; // the sweeper fails it later
    this.complete(m);
  }

  private complete(m: Movement): void {
    const now = this.clock.iso();
    if (m.kind === 'offramp' || m.kind === 'transfer' || m.kind === 'conversion') {
      const w = this.wallets.get(m._private.sourceWalletId)!;
      w.pending -= m._private.held;
      w.updated_at = now;
      m._private.held = 0n;
    }
    if (m.kind === 'conversion') {
      const d = this.wallets.get(m._private.destinationWalletId)!;
      d.available += units(m.destination_amount);
      d.updated_at = now;
    }
    if (m.kind !== 'transfer') m.received_amount = m.destination_amount;
    if (m.kind === 'onramp') {
      // The USDC arrives as a separate child deposit on the wallet's credential: deposit.received, then
      // deposit.confirmed, or deposit.held over the tier cap.
      m._private.depositId = this.payins.onrampDeposit(m._private.walletId, formatAmount(units(m.destination_amount), 6), `txn_${m.id.slice(4)}`);
    }
    this.fxEvent(m, 'completed');
  }

  // ── Validation helpers ──
  private requireId(value: unknown, field: string, prefix: string): string {
    if (typeof value !== 'string' || !value) throw badRequest(field, `${field} should not be empty`);
    if (!ID(prefix).test(value)) throw new ApiError(400, 'invalid_input', `${field} must be a valid ${prefix}_… id (got '${value}')`);
    return value;
  }

  private amounts(body: any): { field: 'source_amount' | 'target_amount'; value: Units } {
    for (const f of ['source_amount', 'target_amount'] as const) {
      if (body[f] !== undefined && (typeof body[f] !== 'string' || !/^\d+(\.\d+)?$/.test(body[f]))) throw badRequest(f, `${f} must be a decimal string`);
    }
    const hasSource = body.source_amount !== undefined;
    const hasTarget = body.target_amount !== undefined;
    if (hasSource === hasTarget) throw new ApiError(400, 'invalid_input', 'exactly one of source_amount or target_amount must be provided');
    const field = hasSource ? 'source_amount' : 'target_amount';
    const value = parseAmount(body[field])!;
    if (value <= 0n) throw new ApiError(400, 'invalid_input', `${field} must be a positive decimal string (got '${body[field]}')`);
    return { field, value };
  }

  walletOr404(id: string) {
    const w = this.wallets.get(id);
    if (!w) throw notFound('Wallet', id);
    return w;
  }

  /** A source amount outside the currency's range is refused with 400 invalid_input. */
  private checkLimits(code: string, source: Units, fromTarget: boolean): void {
    const range = FX_LIMITS[code];
    if (!range) return;
    const [min, max] = range;
    if (source >= units(min) && source <= units(max)) return;
    if (!fromTarget) throw new ApiError(400, 'invalid_input', "Invalid body, check 'errors' property for more info.");
    throw new ApiError(400, 'invalid_input', `Resolved source.amount ${this.fmt(source, code)} is outside the allowed range ${min}\u2013${max} for ${code}`);
  }

  /**
   * The quote's sender: the wallet's customer, or the default customer for tier_0. Each field: the KYC verification
   * snapshot first, the merchant profile second; address only from the profile.
   */
  private requireProfile(customerId: string): void {
    let c = this.customers.get(customerId)!;
    if (c.tier === 'tier_0') c = this.customers.get(this.seed.defaultCustomerId)!;
    const p = c.profile ?? {};
    const v = this.kyc.verifications.get(c.id);
    const doc = v?.idDocs?.[0];
    const dob = v?.dob !== undefined ? v.dob.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1') : p.date_of_birth;
    const fields: Array<[unknown, string]> = c.type === 'business'
      ? [[v?.phone ?? p.phone, 'a phone number'], [v?.registrationNumber ?? p.business_licence, 'business registration number']]
      : [[v?.phone ?? p.phone, 'a phone number'], [dob, 'a date of birth'], [doc?.number ?? p.id_number, 'an ID document number'], [doc?.idDocType ?? p.id_type, 'an ID document type'], [p.address, 'an address']];
    for (const [value, label] of fields) {
      if (typeof value !== 'string' || !value) throw new ApiError(400, 'invalid_input', `customer '${c.id}' must have ${label} to create a quote`);
    }
  }

  private newQuote(op: Kind, fields: Record<string, any>): Record<string, any> {
    const now = this.clock.now();
    const quote = {
      id: newId('quo', now),
      reference: fields.reference ?? null,
      operation: op,
      wallet_id: fields.wallet_id,
      destination_wallet_id: fields.destination_wallet_id ?? null,
      customer_id: fields.customer_id,
      source_amount: fields.source_amount,
      source_currency: fields.source_currency,
      destination_amount: fields.destination_amount,
      received_amount: fields.destination_amount,
      destination_currency: fields.destination_currency,
      rate: formatAmount(units(fields.rate), 6),
      expires_at: this.clock.iso(now + fields.ttl),
      created_at: this.clock.iso(now),
      updated_at: this.clock.iso(now),
      _private: fields._private,
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  /** Quote status is computed, never stored: active or expired. */
  private publicQuote(q: Record<string, any>) {
    const { _private: _p, ...rest } = q;
    return { ...rest, status: this.clock.now() < Date.parse(q.expires_at) ? 'active' : 'expired' };
  }

  // ── Routes ──
  register(http: SimHttp): void {
    const r = http.route.bind(http);

    r('GET', '/v1/me', () => ({
      data: {
        auth_method: 'api_key',
        user: { consumer_user_id: null, email: null, name: null },
        current: { integration_id: this.seed.integrationId, membership_id: 'mem_eval', role: this.seed.role, kyc_reliance_enabled: false },
        effective_role: this.seed.role,
        memberships: [],
      },
    }));

    // Catalog
    r('GET', '/v1/currencies', (req) => {
      const q = req.query;
      const bool = (k: string) => (q.has(k) ? q.get(k) === 'true' : undefined);
      const rows = this.seed.currencies.filter((c) =>
        (!q.get('code') || c.code === q.get('code')) &&
        (!q.get('country_code') || c.country_code === q.get('country_code')) &&
        (!q.get('type') || c.type === q.get('type')) &&
        (['can_onramp', 'can_offramp', 'can_transfer', 'can_deposit', 'can_convert'] as const).every((k) => bool(k) === undefined || c[k] === bool(k)));
      return { data: rows.map((c) => ({ ...c, has_access: !c.requires_access || this.hasAccess(c.code, c.country_code) })) };
    });
    r('GET', '/v1/currencies/access-requests', (req) => ({
      data: this.accessRequests.filter((a) => !req.query.get('status') || a.status === req.query.get('status')),
    }));
    r('POST', '/v1/currencies/{code}/access-requests', (req) => {
      const code = req.params.code!.toUpperCase();
      const country = req.body.countryCode ?? req.body.country_code ?? null;
      const row = this.currencyRow(code, country);
      if (!row) throw notFound('Currency', code);
      if (!row.requires_access) throw new ApiError(400, 'invalid_input', `currency '${code}' does not require access`);
      if (this.hasAccess(code, country ?? row.country_code)) throw new ApiError(409, 'access_already_granted', `Access to currency '${code}' is already granted`);
      const pending = this.accessRequests.find((a) => a.resource_code === code && a.status === 'pending' && (!country || a.country_code === country));
      return { data: pending ?? this.addAccessRequest(code, country ?? row.country_code ?? null, 'pending') };
    });
    r('GET', '/v1/currencies/{code}/rates', (req) => {
      const code = req.params.code!.toUpperCase();
      const rate = this.seed.rates[code];
      if (!rate) throw notFound('Currency', code);
      const row = this.currencyRow(code, req.query.get('country_code'));
      return { data: [{ currency: code, country_code: row?.country_code ?? '', buy: rate, sell: rate }] };
    });
    r('GET', '/v1/countries', (req) => ({
      data: this.seed.countries.filter((c) =>
        (!req.query.get('currency') || c.currencies.includes(req.query.get('currency')!.toUpperCase())) &&
        (!req.query.get('network') || c.networks.includes(req.query.get('network')!))),
    }));
    r('GET', '/v1/countries/{country}/providers', (req) => {
      const country = req.params.country!;
      const list = this.seed.providers[country];
      if (!list) throw new ApiError(400, 'invalid_input', `Country '${country}' is not supported.`);
      return {
        data: list.filter((p) =>
          (!req.query.get('network') || p.network === req.query.get('network')) &&
          (!req.query.has('active') || String(p.active) === req.query.get('active'))),
      };
    });

    // Customers and wallets
    r('POST', '/v1/customers', (req) => ({ data: this.createCustomer(req.body), message: 'Customer created successfully' }), true);
    this.kyc.register(http); // verifications and limits
    r('POST', '/v1/wallets', (req) => {
      const currency = req.body.currency;
      if (typeof currency !== 'string' || !/^[A-Z0-9]{2,8}$/.test(currency)) throw badRequest('currency', 'currency must match /^[A-Z0-9]{2,8}$/ regular expression');
      const customerId = req.body.customer_id ?? this.seed.defaultCustomerId;
      if (!this.customers.has(customerId)) throw notFound('Customer', customerId);
      // A fiat wallet needs an approved customer.
      const kycStatus = this.customers.get(customerId)!.kyc_status;
      if (this.currencyRow(currency)?.type === 'fiat' && kycStatus !== 'approved') {
        throw new ApiError(409, 'invalid_status', `Customer must be approved to create a fiat wallet (current status: '${kycStatus}')`, [CUSTOMER_KYC_NEXT_STEPS_ACTION]);
      }
      const now = this.clock.iso();
      const w = { id: newId('wal', this.clock.now()), customer_id: customerId, currency, label: req.body.label ?? null, available: 0n, pending: 0n, created_at: now, updated_at: now };
      this.wallets.set(w.id, w);
      return { data: this.walletView(w.id), message: 'Wallet created successfully' };
    }, true);
    r('GET', '/v1/customers', (req) => paginate([...this.customers.values()].filter((c) => !req.query.get('type') || c.type === req.query.get('type')), req.query));
    r('GET', '/v1/customers/{id}', (req) => {
      const c = this.customers.get(req.params.id!);
      if (!c) throw notFound('Customer', req.params.id!);
      return { data: c };
    });
    r('GET', '/v1/wallets', (req) => paginate(
      [...this.wallets.values()]
        .filter((w) => (!req.query.get('customer_id') || w.customer_id === req.query.get('customer_id')) && (!req.query.get('currency') || w.currency === req.query.get('currency')))
        .map((w) => this.walletView(w.id)),
      req.query,
    ));
    // Credentials and deposit addresses.
    this.payins.register(http);
    r('GET', '/v1/wallets/{id}', (req) => {
      const w = this.walletOr404(req.params.id!);
      return { data: { ...this.walletView(w.id), credentials: this.payins.credentialsOf(w.id) } };
    });

    // Beneficiaries
    r('POST', '/v1/beneficiaries', (req) => ({ data: this.createBeneficiary(req.body), message: 'Beneficiary created successfully' }));
    r('GET', '/v1/beneficiaries', (req) => paginate(
      [...this.beneficiaries.values()].filter((b) =>
        (!req.query.get('customer_id') || b.customer_id === req.query.get('customer_id')) &&
        (!req.query.get('currency') || b.currency === req.query.get('currency')) &&
        (!req.query.get('type') || b.type === req.query.get('type'))),
      req.query,
    ));
    r('GET', '/v1/beneficiaries/{id}', (req) => {
      const b = this.beneficiaries.get(req.params.id!);
      if (!b) throw notFound('Beneficiary', req.params.id!);
      return { data: b };
    });

    // Quotes
    r('POST', '/v1/offramps/quotes', (req) => ({ data: this.offrampQuote(req.body), message: 'Quote created successfully' }), true);
    r('POST', '/v1/onramps/quotes', (req) => ({ data: this.onrampQuote(req.body), message: 'Quote created successfully' }), true);
    r('POST', '/v1/conversions/quotes', (req) => ({ data: this.conversionQuote(req.body), message: 'Quote created successfully' }), true);
    r('GET', '/v1/quotes/{id}', (req) => {
      const id = this.requireId(req.params.id, 'quote_id', 'quo');
      const q = this.quotes.get(id);
      if (!q) throw notFound('Quote', id);
      return { data: this.publicQuote(q), message: 'Quote fetched successfully' };
    });

    // Movements
    r('POST', '/v1/onramps', (req) => ({ data: this.executeOnramp(req.body), message: 'Onramp executed successfully' }), true);
    r('POST', '/v1/offramps', (req) => ({ data: this.executeFromWallet('offramp', req.body), message: 'Offramp executed successfully' }), true);
    r('POST', '/v1/conversions', (req) => ({ data: this.executeFromWallet('conversion', req.body), message: 'Conversion executed successfully' }), true);
    r('POST', '/v1/transfers', (req) => ({ data: this.transfer(req.body), message: 'Transfer executed successfully' }), true);
    for (const kind of ['onramp', 'offramp', 'conversion', 'transfer'] as const) {
      const name = kind[0]!.toUpperCase() + kind.slice(1);
      r('GET', `/v1/${kind}s`, (req) => this.list(kind, req));
      r('GET', `/v1/${kind}s/{id}`, (req) => {
        const id = this.requireId(req.params.id, `${kind}_id`, PREFIX[kind]);
        const m = this.movements.get(id);
        if (!m || m.kind !== kind) throw notFound(name, id);
        return { data: this.view(m), message: `${name} fetched successfully` };
      });
    }
    // Transactions: movements are roots; an onramp's USDC deposit is a child, listed only with include_related.
    const txnOf = (m: Movement) => ({
      id: `txn_${m.id.slice(4)}`, reference: m.reference ?? null, source_type: m.kind, source_id: m.id, transaction_hash: m.transaction_hash ?? null,
      customer_id: m.customer?.id, from_wallet_id: m._private.sourceWalletId ?? null, to_wallet_id: m._private.walletId ?? m._private.destinationWalletId ?? null,
      type: m.kind, status: m.status, source_amount: m.source_amount ?? m.amount, source_currency: m.source_currency ?? m.currency,
      destination_amount: m.destination_amount ?? null, destination_currency: m.destination_currency ?? null, confirmed_at: null, metadata: {},
      created_at: m.created_at, updated_at: m.updated_at, parent_transaction_id: null, root_transaction_id: `txn_${m.id.slice(4)}`,
    });
    const strip = ({ deposit_timestamp: _d, ...row }: Record<string, any>) => row;
    const allRows = () => [...[...this.movements.values()].map(txnOf), ...this.deposits.map(strip)];
    const TXN_TYPES = ['onramp', 'offramp', 'conversion', 'transfer', 'deposit', 'fee'];
    const SOURCE_TYPES = ['onramp', 'offramp', 'conversion', 'transfer', 'offramp_transfer', 'conversion_transfer', 'deposit_address', 'credential', 'deposit_forward', 'offramp_reversal'];
    r('GET', '/v1/transactions', (req) => {
      const q = req.query;
      for (const [k, allowed] of [['type', TXN_TYPES], ['source_type', SOURCE_TYPES]] as const) {
        const v = q.get(k);
        if (v && !allowed.includes(v)) throw new ApiError(400, 'invalid_input', `${k} must be one of ${allowed.join(', ')} (got '${v}')`);
      }
      // Roots only unless include_related=true: an onramp's USDC deposit and an
      // offramp's reversal credit are children; a walk-in deposit is its own root.
      const related = q.get('include_related') === 'true';
      const rows = allRows()
        .filter((x) => related || x.parent_transaction_id === null)
        .filter((x) => (!q.get('type') || x.type === q.get('type')) && (!q.get('source_type') || x.source_type === q.get('source_type')) && (!q.get('status') || x.status === q.get('status')))
        .filter((x) => (!q.get('wallet_id') || x.to_wallet_id === q.get('wallet_id') || x.from_wallet_id === q.get('wallet_id')) && (!q.get('customer_id') || x.customer_id === q.get('customer_id')) && (!q.get('source_currency') || x.source_currency === q.get('source_currency')))
        .filter((x) => (!q.get('created_after') || x.created_at >= q.get('created_after')!) && (!q.get('created_before') || x.created_at <= q.get('created_before')!))
        .sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
      return { ...paginate(rows, q), message: 'Transactions fetched successfully' };
    });
    r('GET', '/v1/transactions/{id}', (req) => {
      const id = this.requireId(req.params.id, 'transaction_id', 'txn');
      const rows = allRows();
      const row = rows.find((x) => x.id === id);
      if (!row) throw notFound('Transaction', id);
      // The whole tree of the row's root, minus the row itself.
      return { data: { ...row, related_transactions: rows.filter((x) => x.root_transaction_id === row.root_transaction_id && x.id !== id) }, message: 'Transaction fetched successfully' };
    });

    // Webhook endpoints
    r('POST', '/v1/notifications/webhooks', (req) => {
      const url = req.body.url;
      const cats = req.body.event_categories;
      if (!httpsUrl(url)) throw badRequest('url', 'url must be a valid https URL');
      if (!Array.isArray(cats) || !cats.length || cats.some((c: string) => !CATEGORIES.includes(c as Category))) {
        throw badRequest('event_categories', `each value in event_categories must be one of the following values: ${CATEGORIES.join(', ')}`);
      }
      const { secret: _s, ...endpoint } = this.events.createEndpoint(url, cats);
      return { data: endpoint, message: 'Webhook endpoint created' };
    }, true);
    r('GET', '/v1/notifications/webhooks', () => ({ data: [...this.events.endpoints.values()].map(({ secret: _s, ...e }) => e), message: 'Webhook endpoints retrieved' }));
    r('GET', '/v1/notifications/webhooks/{id}', (req) => {
      this.requireId(req.params.id, 'id', 'whr');
      const e = this.events.endpoints.get(req.params.id!);
      if (!e) throw notFound('Webhook endpoint', req.params.id!);
      const { secret: _s, ...view } = e;
      return { data: view };
    });
    r('PATCH', '/v1/notifications/webhooks/{id}', (req) => {
      const e = this.events.endpoints.get(req.params.id!);
      if (!e) throw notFound('Webhook endpoint', req.params.id!);
      if (req.body.url === undefined && req.body.event_categories === undefined && req.body.active === undefined) {
        throw new ApiError(400, 'invalid_input', 'Nothing to update \u2014 provide at least one of: url, event_categories, active');
      }
      if (req.body.url !== undefined && !httpsUrl(req.body.url)) throw badRequest('url', 'url must be a valid https URL');
      if (req.body.url !== undefined) e.url = req.body.url;
      if (req.body.event_categories !== undefined) e.event_categories = req.body.event_categories;
      if (req.body.active !== undefined) e.active = Boolean(req.body.active);
      e.updated_at = this.clock.iso();
      const { secret: _s, ...view } = e;
      return { data: view };
    });
    r('DELETE', '/v1/notifications/webhooks/{id}', (req) => {
      if (!this.events.endpoints.delete(req.params.id!)) throw notFound('Webhook endpoint', req.params.id!);
      return { data: null, message: 'Webhook endpoint deleted' };
    });
  }

  /** Lists honour customer_id, status, created_after/before, page, per_page; nothing else. */
  private list(kind: Kind, req: Request): Reply {
    const parseDate = (v: string | null, end: boolean) => {
      if (!v) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return v;
      throw new ApiError(400, 'invalid_input', `created_${end ? 'before' : 'after'} must be YYYY-MM-DD or an ISO UTC timestamp (got '${v}')`);
    };
    const after = parseDate(req.query.get('created_after'), false);
    const before = parseDate(req.query.get('created_before'), true);
    const status = req.query.get('status');
    // An unknown status is a 400, and transfers have no `returned`.
    const statuses = kind === 'transfer' ? LIST_STATUSES.transfer : kind === 'onramp' ? LIST_STATUSES.onramp : LIST_STATUSES.offramp;
    if (status && !statuses.includes(status)) throw new ApiError(400, 'invalid_input', `status must be one of ${statuses.join(', ')} (got '${status}')`);
    const customer = req.query.get('customer_id');
    const items = [...this.movements.values()]
      .filter((m) => m.kind === kind)
      .filter((m) => (!after || m.created_at >= after) && (!before || m.created_at <= before) && (!status || m.status === status) && (!customer || m.customer?.id === customer))
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1))
      .map((m) => this.view(m));
    return { ...paginate(items, req.query), message: `${kind[0]!.toUpperCase()}${kind.slice(1)}s fetched successfully` };
  }

  /** POST /v1/customers: a new customer starts at tier_0 with KYC not started. */
  private createCustomer(body: any): Record<string, any> {
    if (body.type !== 'individual' && body.type !== 'business') throw badRequest('type', 'type must be one of the following values: individual, business');
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name', 'name should not be empty');
    if (typeof body.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) throw badRequest('email', 'email must be an email');
    if (typeof body.country_code !== 'string' || !/^[A-Z]{2}$/.test(body.country_code)) throw badRequest('country_code', 'country_code must match /^[A-Z]{2}$/ regular expression');
    if (body.type === 'individual' && !/\S\s+\S/.test(body.name.trim())) throw new ApiError(400, 'invalid_input', 'name must include a first and last name for an individual customer');
    const ref = body.merchant_reference ?? newId('ref', this.clock.now());
    if ([...this.customers.values()].some((c) => c.merchant_reference === ref)) throw new ApiError(409, 'duplicate_resource', `Customer with merchant_reference "${ref}" already exists`);
    // Email is unique per integration, case-insensitive.
    if ([...this.customers.values()].some((c) => String(c.email).toLowerCase() === body.email.toLowerCase())) throw new ApiError(409, 'duplicate_resource', `Customer with email "${body.email}" already exists`);
    const now = this.clock.iso();
    const customer = { id: newId('cust', this.clock.now()), type: body.type, name: body.name, email: body.email, merchant_reference: ref, country_code: body.country_code, tier: 'tier_0', kyc_status: 'not_started', metadata: body.metadata ?? {}, profile: body.profile ?? {}, created_at: now, updated_at: now };
    this.customers.set(customer.id, customer);
    return customer;
  }

  /** POST /v1/beneficiaries, in the API's check order. Not idempotent. */
  private createBeneficiary(body: any): Record<string, any> {
    const fiat = body.type === 'fiat';
    const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
    // Every refused field in one 400, as the API reports them.
    const refused = refusedFields([
      [fiat || body.type === 'crypto', 'type', 'type must be one of the following values: fiat, crypto'],
      [text(body.name, 255), 'name', 'name should not be empty'],
      [text(body.label, 128), 'label', 'label should not be empty'],
      [typeof body.currency === 'string' && /^[A-Z0-9]{2,8}$/.test(body.currency), 'currency', 'currency must be 2-8 uppercase alphanumerics'],
      [body.customer_id == null || (typeof body.customer_id === 'string' && /^cust_[0-9A-HJKMNP-TV-Z]{26}$/.test(body.customer_id)), 'customer_id', 'customer_id must be a Global Stack external id (cust_<ULID>)'],
      [text(body.network, Infinity), 'network', 'network should not be empty'],
      [body.rail == null || body.rail === 'payshap', 'rail', 'rail must be one of the following values: payshap'],
      ...(fiat
        ? ([
          [typeof body.country_code === 'string' && /^[A-Z]{2}$/.test(body.country_code), 'country_code', 'country_code must be ISO-3166-1 alpha-2 (e.g. NG, KE)'],
          [(body.rail === 'payshap' && body.provider_id == null) || (typeof body.provider_id === 'string' && /^prov_[0-9A-HJKMNP-TV-Z]{26}$/.test(body.provider_id)), 'provider_id', 'provider_id must be a Global Stack provider id (prov_<ULID>)'],
          [text(body.account_number, 64), 'account_number', 'account_number should not be empty'],
        ] as Array<[boolean, string, string]>)
        : body.type === 'crypto' ? ([[text(body.address, 128), 'address', 'address should not be empty']] as Array<[boolean, string, string]>) : []),
    ]);
    if (refused) throw refused;
    if (fiat) {
      if (body.rail === 'payshap' && (body.currency !== 'ZAR' || body.country_code !== 'ZA' || body.network !== 'bank')) {
        throw new ApiError(400, 'invalid_input', "rail 'payshap' is only available for ZAR bank beneficiaries in ZA");
      }
      if (!['bank', 'mobile_money'].includes(body.network)) throw new ApiError(400, 'invalid_input', 'network must be one of: bank, mobile_money');
      if (body.network === 'mobile_money' && (typeof body.account_name !== 'string' || !body.account_name.trim())) throw new ApiError(400, 'invalid_input', 'account_name is required for mobile_money beneficiaries');
    } else {
      if (!['solana', 'base', 'ethereum'].includes(body.network)) throw new ApiError(400, 'invalid_input', 'network must be one of: solana, base, ethereum');
    }
    const customerId = body.customer_id ?? this.seed.defaultCustomerId;
    if (!this.customers.has(customerId)) throw notFound('Customer', customerId);
    const row = fiat
      ? this.seed.currencies.find((c) => c.code === body.currency && c.country_code === body.country_code && c.can_offramp)
      : this.seed.currencies.find((c) => c.code === body.currency && c.type === 'crypto');
    if (!row) throw new ApiError(400, 'invalid_input', fiat ? `currency '${body.currency}' is not supported for offramp in country '${body.country_code}'` : `crypto currency '${body.currency}' is not supported for offramp`);
    if (!row.networks.some((n) => n.network === body.network)) throw new ApiError(400, 'invalid_input', `network '${body.network}' is not supported for currency '${body.currency}'${fiat ? ` in country '${body.country_code}'` : ''}`);
    this.requireAccess(row, body.country_code);
    const now = this.clock.iso();
    let details: Record<string, any>;
    if (!fiat) {
      details = { network: body.network, address: body.address };
    } else if (body.rail === 'payshap') {
      // The proxy resolves to its bank and holder; provider_id and account_name are ignored.
      const holder = this.seed.knownAccounts[`payshap:${body.account_number}`];
      if (!holder) throw new ApiError(400, 'account_resolution_failed', `Unable to verify PayShap proxy '${body.account_number}'`);
      details = { country_code: 'ZA', network: 'bank', rail: 'payshap', account_number: body.account_number, account_name: holder, provider: null };
    } else {
      const resolves = (body.currency === 'NGN' || body.currency === 'GHS') && body.network === 'bank';
      if (!resolves && body.network === 'bank' && (typeof body.account_name !== 'string' || !body.account_name.trim())) {
        throw new ApiError(400, 'invalid_input', `account_name is required for bank beneficiaries in currency '${body.currency}'`);
      }
      const provider = (this.seed.providers[body.country_code] ?? []).find((p) => p.id === body.provider_id);
      if (!provider) throw new ApiError(400, 'invalid_input', `Account provider with external_id '${body.provider_id}' not found`);
      const account = body.account_number;
      if (body.currency === 'ZAR' && body.network === 'bank') {
        const rejection = zaAccountNumberRejection(account, provider.code);
        if (rejection) throw new ApiError(400, 'invalid_input', rejection);
      }
      let accountName = body.account_name ?? null;
      if (resolves || (body.currency === 'KES' && body.network === 'mobile_money')) {
        // A wrong account and a processor outage look the same: account_resolution_failed.
        const known = this.seed.knownAccounts[`${provider.code}:${account}`] ?? this.seed.knownAccounts[`*:${account}`];
        if (!known) throw new ApiError(400, 'account_resolution_failed', `Unable to verify account '${account}'`);
        if (resolves) accountName = known;
      }
      details = { country_code: body.country_code, network: body.network, account_number: account, account_name: accountName, provider: { id: provider.id, name: provider.name, code: provider.code } };
    }
    const merchantReference = body.merchant_reference ?? newId('ref', this.clock.now());
    if ([...this.beneficiaries.values()].some((b) => b.merchant_reference === merchantReference)) {
      throw new ApiError(409, 'duplicate_resource', `Beneficiary with merchant_reference "${merchantReference}" already exists`);
    }
    const beneficiary = {
      id: newId('ben', this.clock.now()),
      customer_id: customerId,
      name: body.name,
      label: body.label,
      type: body.type,
      currency: body.currency,
      merchant_reference: merchantReference,
      details,
      metadata: body.metadata ?? {},
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    this.beneficiaries.set(beneficiary.id, beneficiary);
    return beneficiary;
  }

  /**
   * USDC leaving a wallet settles in whole cents: a source amount with more than 2 significant decimals is refused.
   * The API exempts custody wallets; the sandbox's wallets are not custody wallets.
   * Target-driven quotes are not checked: their source amount is computed.
   */
  private settlementPrecision(amount: unknown, currency: string): void {
    if (currency !== 'USDC' || typeof amount !== 'string') return;
    if ((amount.split('.')[1] ?? '').replace(/0+$/, '').length > 2) {
      throw new ApiError(400, 'invalid_amount_precision', `USDC amounts support at most 2 decimal places (got '${amount}')`);
    }
  }

  private offrampQuote(body: any) {
    const amt = this.amounts(body);
    const wallet = this.walletOr404(this.requireId(body.wallet_id, 'wallet_id', 'wal'));
    if (amt.field === 'source_amount') this.settlementPrecision(body.source_amount, wallet.currency);
    const benId = this.requireId(body.beneficiary_id, 'beneficiary_id', 'ben');
    const ben = this.beneficiaries.get(benId);
    // A beneficiary on another customer (often the default customer) is invisible to this wallet.
    if (!ben || ben.customer_id !== wallet.customer_id) throw notFound('Beneficiary', benId);
    if (ben.type !== 'fiat') throw new ApiError(400, 'invalid_input', `beneficiary '${ben.id}' is not a fiat beneficiary; offramps require a fiat payout destination`);
    if (!ben.details.account_name) throw new ApiError(400, 'invalid_input', `beneficiary '${ben.id}' has no resolved account name`);
    const row = this.currencyRow(ben.currency, ben.details.country_code);
    if (!row) throw new ApiError(400, 'invalid_input', `currency '${ben.currency}' is not supported`);
    this.requireAccess(row, ben.details.country_code);
    if (!row.can_offramp) throw new ApiError(400, 'invalid_input', `destination_currency '${ben.currency}' does not support offramp`);
    if (wallet.currency === 'USDC') this.payins.ensureCryptoCredential(wallet.id); // mint before the profile check
    this.requireProfile(wallet.customer_id);
    const rate = units(this.seed.rates[ben.currency] ?? '1');
    const source = amt.field === 'source_amount' ? amt.value : roundUp(divUp(amt.value, rate), 2);
    const destination = amt.field === 'target_amount' ? amt.value : roundDown(mul(amt.value, rate), this.precision(ben.currency));
    this.checkLimits(wallet.currency, source, amt.field === 'target_amount');
    return this.publicQuote(this.newQuote('offramp', {
      wallet_id: wallet.id, customer_id: wallet.customer_id, reference: body.narration,
      source_amount: this.fmt(source, wallet.currency), source_currency: wallet.currency,
      destination_amount: this.fmt(destination, ben.currency), destination_currency: ben.currency,
      rate: this.seed.rates[ben.currency], ttl: QUOTE_TTL_MS[ben.currency] ?? 30 * 60_000,
      _private: { beneficiaryId: ben.id, source, corridor: ben.currency },
    }));
  }

  private onrampQuote(body: any) {
    const amt = this.amounts(body);
    const wallet = this.walletOr404(this.requireId(body.wallet_id, 'wallet_id', 'wal'));
    const code = String(body.source_currency ?? '').toUpperCase();
    if (!['mobile_money', 'bank', 'solana', 'base', 'ethereum'].includes(body.source_network)) throw badRequest('source_network', 'source_network must be one of the following values: mobile_money, bank, solana, base, ethereum');
    const matches = this.seed.currencies.filter((c) => c.code === code);
    if (!matches.length) throw new ApiError(400, 'invalid_input', `source_currency '${code}' is not supported`);
    const row = body.country_code ? matches.find((c) => c.country_code === body.country_code) : matches.length === 1 ? matches[0] : undefined;
    if (!row) throw new ApiError(400, 'invalid_input', body.country_code ? `source_currency '${code}' is not supported in country '${body.country_code}'` : `source_currency '${code}' is available in multiple countries; country_code is required`);
    this.requireAccess(row, row.country_code);
    if (!row.can_onramp) throw new ApiError(400, 'invalid_input', `source_currency '${code}' does not support onramp`);
    const network = body.source_network;
    if (network !== 'mobile_money' && body.full_name !== undefined) throw new ApiError(400, 'invalid_input', 'full_name is only valid for mobile_money onramp quotes');
    if (network === 'mobile_money') {
      if (body.phone_number !== undefined && !/^\+[1-9]\d{6,14}$/.test(body.phone_number)) throw badRequest('phone_number', 'phone_number must match /^\\+[1-9]\\d{6,14}$/ regular expression');
      if (!body.phone_number) throw new ApiError(400, 'invalid_input', 'a payer phone_number is required for mobile_money onramps');
      if (!body.provider_id) throw new ApiError(400, 'invalid_input', 'provider_id is required when source_network is mobile_money');
      const providers = this.seed.providers[row.country_code ?? ''] ?? [];
      if (!providers.some((p) => p.id === body.provider_id && p.network === 'mobile_money')) throw new ApiError(400, 'invalid_input', `provider_id '${body.provider_id}' is not a mobile_money provider in ${row.country_code}`);
      if (typeof body.full_name !== 'string' || body.full_name.trim().length < 2) throw new ApiError(400, 'invalid_input', 'full_name is required for mobile_money onramps when phone_number is supplied or the customer is a business');
    }
    if (wallet.currency === 'USDC') this.payins.ensureCryptoCredential(wallet.id); // the USDC recipient
    this.requireProfile(wallet.customer_id);
    const rate = units(this.seed.rates[code] ?? '1');
    // Local currency in, USDC out: USDC = local ÷ rate.
    const local = amt.field === 'source_amount' ? amt.value : roundUp(mul(amt.value, rate), this.precision(code));
    const usdc = amt.field === 'target_amount' ? amt.value : roundDown(div(amt.value, rate), 6);
    this.checkLimits(code, local, amt.field === 'target_amount');
    return this.publicQuote(this.newQuote('onramp', {
      wallet_id: wallet.id, customer_id: wallet.customer_id, reference: body.reference,
      source_amount: this.fmt(local, code), source_currency: code,
      destination_amount: formatAmount(usdc, 6), destination_currency: wallet.currency,
      rate: this.seed.rates[code], ttl: QUOTE_TTL_MS[code] ?? 30 * 60_000,
      _private: { network, country: row.country_code, phone: body.phone_number ?? null, providerId: body.provider_id ?? null, corridor: code },
    }));
  }

  private conversionQuote(body: any) {
    const amt = this.amounts(body);
    const source = this.walletOr404(this.requireId(body.source_wallet_id, 'source_wallet_id', 'wal'));
    const dest = this.walletOr404(this.requireId(body.destination_wallet_id, 'destination_wallet_id', 'wal'));
    if (amt.field === 'source_amount') this.settlementPrecision(body.source_amount, source.currency);
    if (source.currency === dest.currency) throw new ApiError(400, 'invalid_input', `source and destination wallets must have different currencies (both '${source.currency}')`);
    const local = dest.currency === 'USDC' ? source.currency : dest.currency;
    this.requireProfile(source.customer_id);
    const usdcWallet = source.currency === 'USDC' ? source : dest.currency === 'USDC' ? dest : null;
    if (usdcWallet) this.payins.ensureCryptoCredential(usdcWallet.id); // after the profile check for conversions
    const rate = units(this.seed.rates[local] ?? '1');
    const usdcSource = source.currency === 'USDC';
    let s: Units;
    let d: Units;
    if (usdcSource) {
      s = amt.field === 'source_amount' ? amt.value : roundUp(divUp(amt.value, rate), 2);
      d = amt.field === 'target_amount' ? amt.value : roundDown(mul(amt.value, rate), this.precision(dest.currency));
    } else {
      s = amt.field === 'source_amount' ? amt.value : roundUp(mul(amt.value, rate), this.precision(source.currency));
      d = amt.field === 'target_amount' ? amt.value : roundDown(div(amt.value, rate), 6);
    }
    this.checkLimits(source.currency, s, amt.field === 'target_amount');
    return this.publicQuote(this.newQuote('conversion', {
      wallet_id: source.id, destination_wallet_id: dest.id, customer_id: source.customer_id, reference: body.reference,
      source_amount: this.fmt(s, source.currency), source_currency: source.currency,
      destination_amount: this.fmt(d, dest.currency), destination_currency: dest.currency,
      rate: this.seed.rates[local], ttl: QUOTE_TTL_MS[local] ?? 30 * 60_000,
      _private: { source: s, corridor: local },
    }));
  }

  /** Reference: unique per integration per resource, failed movements included. */
  private checkReference(kind: Kind, reference: unknown, required: boolean): string | null {
    if (reference === undefined || reference === null) {
      if (required) throw badRequest('reference', 'reference must be a string');
      return null;
    }
    if (typeof reference !== 'string' || reference.length > 128) throw badRequest('reference', 'reference must be shorter than or equal to 128 characters');
    for (const m of this.movements.values()) {
      if (m.kind === kind && m.reference === reference) {
        throw new ApiError(409, 'duplicate_resource', `${kind === 'onramp' ? 'Onramp with merchant_reference' : `${kind[0]!.toUpperCase()}${kind.slice(1)} with reference`} "${reference}" already exists`);
      }
    }
    return reference;
  }

  /** Checks shared by every quote execute, in the API's order. */
  private quoteFor(kind: Kind, body: any): Record<string, any> {
    const id = this.requireId(body.quote_id, 'quote_id', 'quo');
    const quote = this.quotes.get(id);
    if (!quote) throw notFound('Quote', id);
    if (quote.operation !== kind) throw new ApiError(400, 'invalid_input', `quote '${id}' is not an ${kind} quote (type '${quote.operation}')`);
    if (this.clock.now() >= Date.parse(quote.expires_at)) throw new ApiError(409, 'invalid_status', `Quote status 'expired' cannot be executed`);
    for (const f of ['source_currency', 'destination_currency'] as const) {
      if (body[f] !== undefined && body[f] !== quote[f]) throw new ApiError(400, 'invalid_input', `${f} '${body[f]}' does not match the quote ${f.replace('_', ' ')} '${quote[f]}'`);
    }
    return quote;
  }

  private alreadyExecuted(kind: Kind, quote: Record<string, any>): void {
    if ([...this.movements.values()].some((m) => m.quote_id === quote.id)) {
      throw new ApiError(409, 'duplicate_resource', `${kind[0]!.toUpperCase()}${kind.slice(1)} with quote_id "${quote.id}" already exists`);
    }
  }

  private base(kind: Kind, quote: Record<string, any>, reference: string, body: any): Movement {
    const now = this.clock.iso();
    return {
      id: newId(PREFIX[kind], this.clock.now()),
      kind,
      reference,
      status: 'processing',
      quote_id: quote.id,
      rate_source: 'quoted',
      customer: this.customerView(quote.customer_id),
      source_amount: quote.source_amount,
      source_currency: quote.source_currency,
      destination_amount: quote.destination_amount,
      received_amount: null,
      destination_currency: quote.destination_currency,
      rate: quote.rate,
      failure_reason: null,
      failure_reason_message: null,
      metadata: body.metadata ?? {},
      created_at: now,
      updated_at: now,
      _private: { held: 0n, corridor: quote._private.corridor },
    };
  }

  private executeOnramp(body: any): Record<string, unknown> {
    const quote = this.quoteFor('onramp', body);
    const row = this.currencyRow(quote.source_currency, quote._private.country);
    if (row) this.requireAccess(row, quote._private.country);
    this.alreadyExecuted('onramp', quote);
    const p = quote._private;
    if (p.network === 'mobile_money' && this.behaviour.failNextExecutes > 0) {
      // The provider's execute fails before the row is written: no onramp, quote still usable.
      this.behaviour.failNextExecutes -= 1;
      throw new ApiError(500, 'external_service_unavailable', 'External service unavailable. Try again later.');
    }
    const reference = this.checkReference('onramp', body.reference ?? quote.reference ?? newId('ref', this.clock.now()), false)!;
    const m = this.base('onramp', quote, reference, body);
    m.status = 'awaiting_deposit';
    const expiresAt = p.network === 'bank' ? this.clock.iso(this.clock.now() + UNFUNDED_FAIL_MS[p.corridor]!) : quote.expires_at;
    Object.assign(m, {
      wallet: this.walletRef(quote.wallet_id),
      payment_instrument: null,
      rate_locked_until: null,
      deposit_instruction: p.network === 'bank'
        ? { version: 1, type: 'fiat', accountName: 'GlobalStack Collections', accountNumber: '4100000000', bankName: 'Eval Bank South Africa', bankCode: '250655', expiresAt, depositReference: `GS${m.id.slice(-8)}`, message: 'Include the deposit_reference in the transfer narration/reference so funds are correctly allocated to this deposit.' }
        : { version: 1, type: 'mobile_money', phoneNumber: p.phone, providerId: p.providerId, instructions: 'Follow the prompt on your phone to authorize the payment.', expiresAt },
    });
    m._private = { ...m._private, network: p.network, walletId: quote.wallet_id, phone: p.phone };
    this.movements.set(m.id, m);
    if (p.network === 'mobile_money') this.clock.after(100, () => this.fxEvent(m, 'created'));
    // The sweeper fails conversions still unfunded after a fixed age.
    const quoteAge = this.clock.now() - Date.parse(quote.created_at);
    this.clock.after(Math.max(0, UNFUNDED_FAIL_MS[p.corridor]! - quoteAge), () => {
      if (m.status === 'awaiting_deposit') this.fxEvent(m, 'failed', 'quote_expired');
    });
    if (p.network === 'mobile_money') {
      if (this.behaviour.payerApproves) this.progress(m);
    }
    return this.view(m);
  }

  private executeFromWallet(kind: 'offramp' | 'conversion', body: any): Record<string, unknown> {
    const quote = this.quoteFor(kind, body);
    this.alreadyExecuted(kind, quote);
    const reference = this.checkReference(kind, body.reference, true)!;
    const wallet = this.wallets.get(quote.wallet_id)!;
    const amount: Units = quote._private.source;
    const m = this.base(kind, quote, reference, body);
    if (kind === 'offramp') {
      const ben = this.beneficiaries.get(quote._private.beneficiaryId)!;
      Object.assign(m, {
        retry_on_failure: false,
        wallet: this.walletRef(wallet.id),
        beneficiary: ben,
        narration: quote.reference,
        payment_instrument: { id: newId('pay', this.clock.now()), beneficiary_id: ben.id, type: ben.details.network === 'bank' ? 'bank_account' : 'mobile_money', country_code: ben.details.country_code, provider: ben.details.provider ?? null, account_name: String(ben.name).toUpperCase(), account_number: ben.details.account_number },
        rate_locked_until: quote.expires_at,
      });
    } else {
      Object.assign(m, { source_wallet: this.walletRef(wallet.id), destination_wallet: this.walletRef(quote.destination_wallet_id) });
    }
    m.metadata = { ...(body.metadata ?? {}), transfer_external_id: newId('tfr', this.clock.now()) };
    m._private = { ...m._private, sourceWalletId: wallet.id, destinationWalletId: quote.destination_wallet_id };
    this.movements.set(m.id, m);
    // Failures inside execute write `failed` directly and send no webhook.
    if (wallet.available < amount) {
      m.status = 'failed';
      m.failure_reason = 'insufficient_funds';
      m.failure_reason_message = 'The wallet balance was too low for this payment.';
      throw new ApiError(422, 'ledger_insufficient_funds', `wallet '${wallet.id}' available balance is below the transfer amount`);
    }
    wallet.available -= amount;
    wallet.pending += amount;
    m._private.held = amount;
    if (this.behaviour.failNextExecutes > 0) {
      this.behaviour.failNextExecutes -= 1;
      this.release(m);
      m.status = 'failed';
      m.failure_reason = 'temporarily_unavailable';
      m.failure_reason_message = 'The provider was temporarily unavailable.';
      throw new ApiError(500, 'external_service_unavailable', 'External service unavailable. Try again later.');
    }
    this.progress(m);
    return this.view(m);
  }

  private transfer(body: any): Record<string, unknown> {
    const wallet = this.walletOr404(this.requireId(body.wallet_id, 'wallet_id', 'wal'));
    const benId = this.requireId(body.beneficiary_id, 'beneficiary_id', 'ben');
    // Any crypto beneficiary of the integration works: no same-customer rule for transfers.
    const ben = this.beneficiaries.get(benId);
    if (!ben) throw notFound('Beneficiary', benId);
    if (ben.type !== 'crypto') throw new ApiError(400, 'invalid_input', `beneficiary '${ben.id}' is not a crypto beneficiary (type '${ben.type}')`);
    if (ben.currency !== wallet.currency) throw new ApiError(400, 'invalid_input', `wallet currency '${wallet.currency}' does not match beneficiary currency '${ben.currency}'`);
    if (typeof body.amount !== 'string' || !/^\d+(\.\d+)?$/.test(body.amount)) throw badRequest('amount', 'amount must be a decimal string');
    const amount = parseAmount(body.amount)!;
    if (amount < units('2.5') || amount > units('100000')) throw new ApiError(400, 'invalid_input', `amount '${body.amount}' is outside the allowed range [2.5, 100000] for network '${ben.details.network}'`);
    this.settlementPrecision(body.amount, wallet.currency);
    const reference = this.checkReference('transfer', body.reference, true)!;
    const now = this.clock.iso();
    const m: Movement = {
      id: newId('tfr', this.clock.now()),
      kind: 'transfer',
      reference,
      status: 'processing',
      retry_on_failure: body.retry_on_failure ?? true,
      customer: this.customerView(wallet.customer_id),
      wallet: this.walletRef(wallet.id),
      beneficiary: ben,
      amount: formatAmount(amount, 6),
      currency: wallet.currency,
      network: ben.details.network,
      transaction_hash: null,
      failure_reason: null,
      failure_reason_message: null,
      metadata: body.metadata ?? {},
      created_at: now,
      updated_at: now,
      _private: { held: 0n, sourceWalletId: wallet.id },
    };
    this.movements.set(m.id, m);
    if (wallet.available < amount) {
      // The row stays `processing` forever with no webhook.
      throw new ApiError(422, 'ledger_insufficient_funds', `wallet '${wallet.id}' available balance is below the transfer amount`);
    }
    wallet.available -= amount;
    wallet.pending += amount;
    m._private.held = amount;
    if (this.behaviour.failNextExecutes > 0) {
      this.behaviour.failNextExecutes -= 1;
      this.release(m);
      m.status = 'failed';
      m.failure_reason = 'temporarily_unavailable';
      m.failure_reason_message = 'The network was temporarily unavailable.';
      throw new ApiError(500, 'external_service_unavailable', 'External service unavailable. Try again later.');
    }
    this.progress(m);
    return this.view(m);
  }
}

/** The API's ZAR bank account number rule: digits only, per-bank length, else 8 to 11. */
const ZA_BANK_DIGITS: Record<string, [string, number[]]> = {
  '051001': ['Standard Bank', [9, 11]], '198765': ['Nedbank', [10]], '250655': ['FNB', [11]], '430000': ['African Bank', [11]],
  '470010': ['Capitec', [10]], '580105': ['Investec', [11]], '632005': ['Absa', [8, 9, 10, 11]], '678910': ['TymeBank', [11]],
  '679000': ['Discovery', [11]], '888000': ['Bank Zero', [11]], TYME_BANK: ['TymeBank', [11]],
};

function zaAccountNumberRejection(accountNumber: string, providerCode: string | undefined): string | null {
  if (!/^[0-9]+$/.test(accountNumber)) return 'South African account numbers are digits only. Remove any spaces, dashes or other characters.';
  const digits = accountNumber.length;
  const bank = providerCode ? ZA_BANK_DIGITS[providerCode] : undefined;
  if (bank) {
    const [name, allowed] = bank;
    if (allowed.includes(digits)) return null;
    const list = allowed.length === 1 ? String(allowed[0]) : `${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}`;
    return `${name} accounts are ${list} digits; this account number has ${digits}.`;
  }
  if (digits < 8 || digits > 11) return `South African account numbers are 8 to 11 digits; this account number has ${digits}.`;
  return null;
}
