// Pay-ins (wallet credentials and deposit addresses), inbound USDC deposits, and the tier money-in cap.
// Behaviour follows the live API. The API source lines and spec sections behind each rule are cited in this file at
// commit 5ea09fa (plugin 0.2.1); shipped code no longer names them.
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, badRequest, formatAmount, newId, notFound, parseAmount, type Units } from './core.ts';
import type { GlobalStack } from './api.ts';
import { paginate, type Reply, type Request, type SimHttp } from './http.ts';

type Purpose = 'credential' | 'deposit_address';
type PayInStatus = 'pending' | 'active' | 'frozen' | 'disabled';

export interface PayIn {
  id: string;
  purpose: Purpose;
  walletId: string;
  customerId: string;
  type: 'crypto' | 'fiat';
  currency: string;
  network: string;
  label: string | null;
  metadata: Record<string, string>;
  details: Record<string, unknown>;
  status: PayInStatus;
  providerResourceId: string;
  merchantReference: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How the provider reports an inbound on-chain deposit.
 * - auto: `pending` now (deposit.received), `completed` after `behaviour.stepMs`
 * - manual: `pending` only; the grader sends `completed` with confirmDeposit()
 * - direct: only `completed` (no deposit.received)
 */
export interface DepositOptions {
  flow?: 'auto' | 'manual' | 'direct';
  fromAddress?: string;
  txHash?: string;
}

interface DepositState {
  row: Record<string, any>;
  payInId: string;
  walletId: string;
  amount: Units;
  /** Where the credit sits in the ledger: inflight (held), settled, voided by ops, or not recorded yet. */
  ledger: 'none' | 'held' | 'settled' | 'voided';
  depositTimestamp: string;
}

interface Reservation {
  ref: string;
  subjectId: string;
  amountUsd: number;
  status: 'confirmed' | 'held' | 'released';
  reservedAt: number;
}

const NETWORKS = ['mobile_money', 'bank', 'solana', 'base', 'ethereum'];
const CHAINS = ['solana', 'base', 'ethereum'];
const PAYIN_STATUSES = ['pending', 'active', 'frozen', 'disabled'];
const ROLLING_WINDOW_MS = 30 * 24 * 3600_000;
const CUSTOMER_KYC_NEXT_STEPS_ACTION = 'Drive the customer through KYC via POST /v1/customers/:id/verifications, then retry.';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(44, '1');
}

/** A fresh on-chain address for the chain: EVM `0x` + 40 hex, Solana base58. */
function newAddress(chain: string): string {
  return chain === 'solana' ? base58(randomBytes(32)) : `0x${randomBytes(20).toString('hex')}`;
}

const ID = (value: unknown, prefix: string, field: string): string => {
  if (typeof value !== 'string' || !value.startsWith(`${prefix}_`)) {
    throw new ApiError(400, 'invalid_input', `${field} must be a valid ${prefix}_… id (got '${String(value)}')`);
  }
  return value;
};

export class PayIns {
  readonly payIns = new Map<string, PayIn>();
  readonly depositStates = new Map<string, DepositState>();
  readonly reservations: Reservation[] = [];
  private readonly gs: GlobalStack;

  constructor(gs: GlobalStack) {
    this.gs = gs;
  }

  // ── Views ──
  credentialView(p: PayIn) {
    return {
      id: p.id, type: p.type, currency: p.currency, network: p.network, wallet: this.gs.walletRef(p.walletId), label: p.label,
      metadata: p.metadata, details: p.details, status: p.status, provider_resource_id: p.providerResourceId, created_at: p.createdAt, updated_at: p.updatedAt,
    };
  }

  depositAddressView(p: PayIn) {
    const w = this.gs.wallets.get(p.walletId)!;
    return {
      id: p.id, type: p.type, currency: w.currency, wallet: this.gs.walletRef(p.walletId), label: p.label, metadata: p.metadata,
      details: p.details, status: p.status, provider_resource_id: p.providerResourceId, created_at: p.createdAt, updated_at: p.updatedAt,
    };
  }

  /** Newest first. */
  private ofWallet(walletId: string, purpose: Purpose): PayIn[] {
    return [...this.payIns.values()].filter((p) => p.walletId === walletId && p.purpose === purpose).reverse();
  }

  credentialsOf(walletId: string) {
    return this.ofWallet(walletId, 'credential').map((p) => this.credentialView(p));
  }

  // ── Creating pay-ins ──
  private customerOf(walletId: string): Record<string, any> {
    return this.gs.customers.get(this.gs.wallets.get(walletId)!.customer_id)!;
  }

  private insert(fields: Omit<PayIn, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'providerResourceId' | 'merchantReference'> & { merchantReference?: string }): PayIn {
    const now = this.gs.clock.iso();
    const prefix = fields.purpose === 'deposit_address' ? 'da' : 'wcr';
    const payIn: PayIn = {
      ...fields,
      id: newId(prefix, this.gs.clock.now()),
      merchantReference: fields.merchantReference ?? newId('ref', this.gs.clock.now()),
      status: 'active',
      providerResourceId: '',
      createdAt: now,
      updatedAt: now,
    };
    if (fields.type === 'crypto') {
      // Production custody path: a custody wallet is minted, the row turns active with
      // { network, address, chain, currency }.
      payIn.providerResourceId = newId('cdw', this.gs.clock.now());
      payIn.details = { network: fields.network, address: newAddress(fields.network), chain: fields.network, currency: fields.currency.toLowerCase() };
    } else {
      // Fiat: the provider opens a virtual bank account. Account values are sim fixtures.
      payIn.providerResourceId = newId('fac', this.gs.clock.now());
      const customer = this.customerOf(fields.walletId);
      payIn.details = { accountName: String(customer.name), accountNumber: String(Math.floor(1e9 + Math.random() * 9e9)), bankName: 'Eval Bank', bankCode: '000', currency: fields.currency };
    }
    this.payIns.set(payIn.id, payIn);
    return payIn;
  }

  /** POST /v1/wallets/{id}/credentials, in the API's check order. */
  createCredential(walletParam: unknown, body: any): PayIn {
    if (typeof body.network !== 'string' || !NETWORKS.includes(body.network)) throw badRequest('network', `network must be one of: ${NETWORKS.join(', ')}`);
    if (body.type !== undefined && !['crypto', 'fiat'].includes(body.type)) throw badRequest('type', 'type must be one of: crypto, fiat');
    if (body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Z]{2,10}$/.test(body.currency))) throw badRequest('currency', 'currency must be an uppercase 2-10 character code');
    if (body.country_code !== undefined && (typeof body.country_code !== 'string' || !/^[A-Z]{2}$/.test(body.country_code))) throw badRequest('country_code', 'country_code must be a 2-letter uppercase ISO 3166-1 alpha-2 code (e.g. NG)');
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 128)) throw badRequest('label', 'label must be shorter than or equal to 128 characters');
    if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) throw badRequest('metadata', 'metadata must be an object');
    const walletId = ID(walletParam, 'wal', 'id');
    const wallet = this.gs.walletOr404(walletId);
    const customer = this.customerOf(wallet.id);
    const currency = this.gs.currencyRow(wallet.currency);
    if (!currency) throw new ApiError(500, 'configuration_error', `Wallet '${wallet.id}' references unknown currency '${wallet.currency}'`);
    this.gs.requireAccess(currency);
    if ((body.currency ?? wallet.currency) !== wallet.currency) {
      // Cross-currency (auto-conversion) credentials exist in the API; gs-sim does not model them.
      throw new ApiError(400, 'invalid_input', 'cross-currency credentials are not supported by gs-sim');
    }
    if (body.country_code !== undefined) {
      if (currency.type === 'crypto') throw new ApiError(400, 'invalid_input', 'country_code cannot be supplied for a same-currency credential on a wallet without a pinned country');
      if (currency.country_code && body.country_code !== currency.country_code) throw new ApiError(400, 'invalid_input', `country_code '${body.country_code}' does not match wallet country '${currency.country_code}'`);
    }
    if (body.type !== undefined && body.type !== currency.type) throw new ApiError(400, 'invalid_input', `type '${body.type}' does not match wallet currency type '${currency.type}'`);
    if (!currency.networks.some((n) => n.network === body.network)) throw new ApiError(400, 'invalid_input', `network '${body.network}' is not supported by currency ${currency.code}`);
    if (currency.type === 'crypto' && !currency.can_deposit) throw new ApiError(400, 'invalid_input', `currency '${currency.code}' does not support deposits`);
    if (currency.type === 'fiat' && body.network !== 'bank') throw new ApiError(400, 'invalid_input', "fiat credentials currently only support the 'bank' network");
    if (currency.type === 'fiat' && customer.kyc_status !== 'approved') {
      throw new ApiError(409, 'invalid_status', `Customer must be approved to create a fiat credential (current status: '${customer.kyc_status}')`, [CUSTOMER_KYC_NEXT_STEPS_ACTION]);
    }
    return this.insert({
      purpose: 'credential', walletId: wallet.id, customerId: wallet.customer_id, type: currency.type, currency: currency.code, network: body.network,
      label: body.label ?? null, metadata: body.metadata ?? {}, details: {}, merchantReference: body.merchantReference,
    });
  }

  /** POST /v1/wallets/{id}/deposit-addresses. */
  createDepositAddress(walletParam: unknown, body: any): PayIn {
    if (typeof body.network !== 'string' || !CHAINS.includes(body.network)) throw badRequest('network', `network must be one of: ${CHAINS.join(', ')}`);
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 128)) throw badRequest('label', 'label must be shorter than or equal to 128 characters');
    if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) throw badRequest('metadata', 'metadata must be an object');
    const walletId = ID(walletParam, 'wal', 'id');
    const wallet = this.gs.walletOr404(walletId);
    const currency = this.gs.currencyRow(wallet.currency);
    if (!currency) throw new ApiError(500, 'configuration_error', `Wallet '${wallet.id}' references unknown currency '${wallet.currency}'`);
    this.gs.requireAccess(currency);
    if (!currency.networks.some((n) => n.network === body.network)) throw new ApiError(400, 'invalid_input', `network '${body.network}' is not supported by currency ${currency.code}`);
    if (currency.type !== 'crypto') throw new ApiError(400, 'invalid_input', `deposit addresses are only available for crypto wallets (wallet currency '${currency.code}' is ${currency.type})`);
    if (!currency.can_deposit) throw new ApiError(400, 'invalid_input', `currency '${currency.code}' does not support deposits`);
    return this.insert({
      purpose: 'deposit_address', walletId: wallet.id, customerId: wallet.customer_id, type: 'crypto', currency: currency.code, network: body.network,
      label: body.label ?? null, metadata: body.metadata ?? {}, details: {}, merchantReference: body.merchantReference,
    });
  }

  /**
   * A quote on a USDC wallet uses its newest active crypto credential, minting a solana one with the wallet's
   * label when there is none.
   */
  ensureCryptoCredential(walletId: string): PayIn {
    const w = this.gs.wallets.get(walletId)!;
    const found = this.ofWallet(walletId, 'credential').find((p) => p.status === 'active' && p.type === 'crypto' && p.currency === w.currency);
    if (found) return found;
    return this.insert({ purpose: 'credential', walletId, customerId: w.customer_id, type: 'crypto', currency: w.currency, network: 'solana', label: w.label, metadata: {}, details: {} });
  }

  private find(walletParam: unknown, idParam: unknown, purpose: Purpose): PayIn {
    const walletId = ID(walletParam, 'wal', 'id');
    const id = purpose === 'credential' ? ID(idParam, 'wcr', 'credential_id') : ID(idParam, 'da', 'deposit_address_id');
    const wallet = this.gs.walletOr404(walletId);
    const p = this.payIns.get(id);
    if (!p || p.walletId !== wallet.id || p.purpose !== purpose) throw notFound(purpose === 'credential' ? 'Wallet credential' : 'Wallet deposit address', id);
    return p;
  }

  /** DELETE: pending/active -> disabled; disabled or frozen -> 409. */
  private deactivate(p: PayIn): void {
    if (p.status === 'disabled' || p.status === 'frozen') {
      throw new ApiError(409, 'invalid_status', `${p.purpose === 'credential' ? 'Wallet credential' : 'Wallet deposit address'} status '${p.status}' cannot be deactivated`);
    }
    p.status = 'disabled';
    p.updatedAt = this.gs.clock.iso();
  }

  private listOf(walletParam: unknown, purpose: Purpose, req: Request): Reply {
    const walletId = ID(walletParam, 'wal', 'id');
    const wallet = this.gs.walletOr404(walletId);
    const status = purpose === 'deposit_address' ? req.query.get('status') : null;
    if (status && !PAYIN_STATUSES.includes(status)) throw new ApiError(400, 'invalid_input', `status must be one of ${PAYIN_STATUSES.join(', ')} (got '${status}')`);
    const items = this.ofWallet(wallet.id, purpose).filter((p) => !status || p.status === status);
    return paginate(items.map((p) => (purpose === 'credential' ? this.credentialView(p) : this.depositAddressView(p))), req.query);
  }

  register(http: SimHttp): void {
    const r = http.route.bind(http);
    r('POST', '/v1/wallets/{id}/credentials', (req) => ({ data: this.credentialView(this.createCredential(req.params.id, req.body)), message: 'Wallet credential created successfully' }), true);
    r('GET', '/v1/wallets/{id}/credentials', (req) => ({ ...this.listOf(req.params.id, 'credential', req), message: 'Wallet credentials fetched successfully' }));
    r('GET', '/v1/wallets/{id}/credentials/{credentialId}', (req) => ({ data: this.credentialView(this.find(req.params.id, req.params.credentialId, 'credential')), message: 'Wallet credential fetched successfully' }));
    r('DELETE', '/v1/wallets/{id}/credentials/{credentialId}', (req) => {
      const p = this.find(req.params.id, req.params.credentialId, 'credential');
      this.deactivate(p);
      return { data: { id: p.id, success: true }, message: 'Wallet credential has been successfully deactivated' };
    });
    r('POST', '/v1/wallets/{id}/deposit-addresses', (req) => ({ data: this.depositAddressView(this.createDepositAddress(req.params.id, req.body)), message: 'Wallet deposit address created successfully' }), true);
    r('GET', '/v1/wallets/{id}/deposit-addresses', (req) => ({ ...this.listOf(req.params.id, 'deposit_address', req), message: 'Deposit addresses fetched successfully' }));
    r('GET', '/v1/wallets/{id}/deposit-addresses/{daId}', (req) => ({ data: this.depositAddressView(this.find(req.params.id, req.params.daId, 'deposit_address')), message: 'Deposit address fetched successfully' }));
    r('DELETE', '/v1/wallets/{id}/deposit-addresses/{daId}', (req) => {
      const p = this.find(req.params.id, req.params.daId, 'deposit_address');
      this.deactivate(p);
      return { data: { id: p.id, success: true }, message: 'Deposit address has been successfully deactivated' };
    });
  }

  // ── Inbound deposits ──
  /** Finds the pay-in an on-chain deposit landed on: by address, or by its wcr_/da_ id. */
  resolveTarget(target: string): PayIn {
    const byId = this.payIns.get(target);
    if (byId) return byId;
    const lower = target.toLowerCase();
    const byAddress = [...this.payIns.values()].find((p) => typeof p.details.address === 'string' && (p.details.address === target || (target.startsWith('0x') && (p.details.address as string).toLowerCase() === lower)));
    if (!byAddress) throw new Error(`gs-sim: no credential or deposit address matches '${target}'`);
    return byAddress;
  }

  /** Records the deposit row and runs its lifecycle. Returns the deposit's `txn_` id. */
  inbound(payIn: PayIn, amount: string, options: DepositOptions = {}, parentTransactionId: string | null = null): string {
    const value = parseAmount(amount);
    if (value === null || value <= 0n) throw new Error(`gs-sim: bad deposit amount '${amount}'`);
    if (payIn.type !== 'crypto') throw new Error('gs-sim: fiat deposits are not simulated');
    const w = this.gs.wallets.get(payIn.walletId)!;
    const now = this.gs.clock.iso();
    const identity = randomUUID(); // the provider's id for the deposit (format unconfirmed)
    const shown = formatAmount(value, 6);
    const txnId = newId('txn', this.gs.clock.now());
    const row: Record<string, any> = {
      id: txnId,
      reference: `dep-${identity}`,
      source_type: payIn.purpose,
      source_id: payIn.id,
      transaction_hash: options.txHash ?? (payIn.network === 'solana' ? base58(randomBytes(64)).slice(0, 88) : `0x${randomBytes(32).toString('hex')}`),
      customer_id: payIn.customerId,
      from_wallet_id: null,
      to_wallet_id: w.id,
      type: 'deposit',
      status: 'processing',
      source_amount: shown,
      source_currency: payIn.currency,
      destination_amount: shown,
      destination_currency: payIn.currency,
      confirmed_at: null,
      metadata: { to_address: payIn.details.address, from_address: options.fromAddress ?? newAddress(payIn.network), ledger_transaction_id: randomUUID(), event_id: randomUUID() },
      created_at: now,
      updated_at: now,
      parent_transaction_id: parentTransactionId,
      root_transaction_id: parentTransactionId ?? txnId,
      deposit_timestamp: now,
    };
    const state: DepositState = { row, payInId: payIn.id, walletId: w.id, amount: value, ledger: 'none', depositTimestamp: now };
    this.depositStates.set(txnId, state);
    const flow = options.flow ?? 'auto';
    if (flow === 'direct') {
      this.terminal(state);
    } else {
      this.pending(state);
      if (flow === 'auto') this.gs.clock.after(this.gs.behaviour.stepMs, () => this.terminal(state));
    }
    return txnId;
  }

  private emit(outcome: 'received' | 'held' | 'confirmed' | 'failed', state: DepositState, occurredAt = state.depositTimestamp): void {
    // Status = outcome, changes null, event_created_at = deposit time.
    this.gs.events.emit(`deposit.${outcome}`, { ...state.row }, null, { status: outcome, occurredAt });
  }

  /** Provider state `pending`: inflight credit (pending_balance), row `processing`, deposit.received. */
  private pending(state: DepositState): void {
    const w = this.gs.wallets.get(state.walletId)!;
    if (state.ledger === 'none') {
      w.pending += state.amount;
      w.updated_at = this.gs.clock.iso();
      state.ledger = 'held';
    }
    if (!this.gs.deposits.includes(state.row)) this.gs.deposits.push(state.row);
    this.emit('received', state);
  }

  /** Provider state `completed`: tier check, then settle (deposit.confirmed) or keep held (deposit.held), or fail a voided hold. */
  private terminal(state: DepositState): void {
    const payIn = this.payIns.get(state.payInId)!;
    const w = this.gs.wallets.get(state.walletId)!;
    const row = state.row;
    const blocked = payIn.status === 'frozen' || payIn.status === 'disabled';
    const heldForTier = !blocked && this.evaluateTier(payIn.customerId, row.destination_amount, row.reference, Date.parse(state.depositTimestamp)) === 'hold';
    const shouldSettle = !blocked && !heldForTier;
    const now = this.gs.clock.iso();
    if (!this.gs.deposits.includes(row)) this.gs.deposits.push(row);

    if (shouldSettle && state.ledger === 'voided') {
      // A hold ops already voided can never settle: row failed, no credit, deposit.failed.
      if (row.status === 'processing') {
        row.status = 'failed';
        row.metadata = { ...row.metadata, failure_reason: 'hold_voided' };
        row.updated_at = now;
      }
      this.emit('failed', state);
      return;
    }
    if (state.ledger === 'none') {
      if (shouldSettle) w.available += state.amount;
      else w.pending += state.amount;
      state.ledger = shouldSettle ? 'settled' : 'held';
    } else if (state.ledger === 'held' && shouldSettle) {
      w.pending -= state.amount;
      w.available += state.amount;
      state.ledger = 'settled';
    }
    w.updated_at = now;
    if (!shouldSettle) {
      if (row.status === 'processing') {
        row.status = 'received';
        row.metadata = { ...row.metadata, hold_reason: blocked ? (payIn.status === 'frozen' ? 'payin_frozen' : 'payin_disabled') : 'tier_limit' };
        row.updated_at = now;
      }
      this.emit('held', state);
      return;
    }
    if (row.status === 'processing' || row.status === 'received') {
      row.status = 'success';
      row.confirmed_at = state.depositTimestamp;
      row.updated_at = now;
    }
    this.emit('confirmed', state);
  }

  // ── Grader controls ──
  /** Sends the provider's `completed` for a deposit simulated with flow 'manual'. */
  confirmDeposit(txnId: string): void {
    const state = this.depositStates.get(txnId);
    if (!state) throw new Error(`gs-sim: unknown deposit ${txnId}`);
    this.terminal(state);
  }

  /** Ops voids a still-inflight deposit credit in the ledger; its `completed` then fails it (deposit.failed). */
  voidDepositHold(txnId: string): void {
    const state = this.depositStates.get(txnId);
    if (!state || state.ledger !== 'held' || state.row.status !== 'processing') throw new Error(`gs-sim: deposit ${txnId} has no inflight hold to void`);
    const w = this.gs.wallets.get(state.walletId)!;
    w.pending -= state.amount;
    w.updated_at = this.gs.clock.iso();
    state.ledger = 'voided';
  }

  /** Releases a tier-held deposit: credit settles, row success, deposit.confirmed. */
  releaseHeldDeposit(txnId: string): void {
    const state = this.depositStates.get(txnId);
    if (!state) throw new Error(`gs-sim: unknown deposit ${txnId}`);
    const reservation = this.reservations.find((r) => r.ref === state.row.reference);
    // A deposit held only because its pay-in is disabled/frozen has no reservation: no release path exists.
    if (!reservation) throw new Error(`gs-sim: TierReservation '${state.row.reference}' not found`);
    const w = this.gs.wallets.get(state.walletId)!;
    if (state.ledger === 'held') {
      w.pending -= state.amount;
      w.available += state.amount;
      w.updated_at = this.gs.clock.iso();
      state.ledger = 'settled';
    }
    if (reservation.status === 'held') reservation.status = 'confirmed';
    const row = state.row;
    if (row.status !== 'received') return; // already confirmed: no second event
    row.status = 'success';
    row.confirmed_at = this.gs.clock.iso();
    row.updated_at = row.confirmed_at;
    const { hold_reason: _h, ...metadata } = row.metadata;
    row.metadata = metadata;
    this.emit('confirmed', state, row.created_at);
  }

  /**
   * The onramp's USDC: the provider pays the wallet's crypto credential, and the API records a child deposit of the
   * onramp. Both provider states arrive back to back, as before.
   */
  onrampDeposit(walletId: string, amount: string, parentTransactionId: string): string {
    const credential = this.ensureCryptoCredential(walletId);
    const txnId = this.inbound(credential, amount, { flow: 'manual' }, parentTransactionId);
    this.terminal(this.depositStates.get(txnId)!);
    return txnId;
  }

  // ── Tier money-in cap ──
  /** tier_0 money-in counts against the integration default customer. */
  private subjectOf(customerId: string): Record<string, any> {
    const c = this.gs.customers.get(customerId)!;
    return c.tier === 'tier_0' ? this.gs.customers.get(this.gs.seed.defaultCustomerId)! : c;
  }

  /** tier_0 has no cap of its own; tier_1 and tier_2 share USD 1,000,000 per rolling 30 days. */
  private capOf(tier: string): number | null {
    const cap = (this.gs.behaviour.tierCapsUsd as Record<string, string | undefined>)[tier];
    return cap === undefined ? null : Number(cap);
  }

  private usedBy(subjectId: string, since: number): number {
    return this.reservations.filter((r) => r.subjectId === subjectId && r.status === 'confirmed' && r.reservedAt > since).reduce((s, r) => s + r.amountUsd, 0);
  }

  private evaluateTier(customerId: string, amount: string, ref: string, reservedAt: number): 'settle' | 'hold' {
    if (!this.gs.behaviour.tierEnforcement) return 'settle'; // on in production
    const existing = this.reservations.find((r) => r.ref === ref);
    if (existing) return existing.status === 'held' ? 'hold' : 'settle';
    const subject = this.subjectOf(customerId);
    const cap = this.capOf(subject.tier);
    const amountUsd = Math.round(Number(amount) * 100) / 100; // USDC counts 1:1
    const decision = cap === null || this.usedBy(subject.id, reservedAt - ROLLING_WINDOW_MS) + amountUsd <= cap ? 'settle' : 'hold';
    this.reservations.push({ ref, subjectId: subject.id, amountUsd, status: decision === 'settle' ? 'confirmed' : 'held', reservedAt });
    return decision;
  }

  /** After a tier promotion: the customer's own held deposits, oldest first, as many as the new cap allows. */
  releaseAfterPromotion(customerId: string): string[] {
    const c = this.gs.customers.get(customerId)!;
    const cap = this.capOf(c.tier);
    const windowStart = this.gs.clock.now() - ROLLING_WINDOW_MS;
    let used = this.usedBy(customerId, windowStart);
    const held = this.reservations.filter((r) => r.subjectId === customerId && r.status === 'held').sort((a, b) => a.reservedAt - b.reservedAt);
    const refs: string[] = [];
    for (const h of held) {
      if (cap === null || h.reservedAt <= windowStart) refs.push(h.ref);
      else if (used + h.amountUsd <= cap) {
        refs.push(h.ref);
        used += h.amountUsd;
      }
    }
    const released: string[] = [];
    for (const ref of refs) {
      const state = [...this.depositStates.values()].find((s) => s.row.reference === ref);
      if (state) {
        this.releaseHeldDeposit(state.row.id);
        released.push(state.row.id);
      }
    }
    return released;
  }

  /** GET /v1/customers/{id}/limits. */
  limits(customerId: string) {
    const c = this.gs.customers.get(customerId)!;
    const subject = this.subjectOf(customerId);
    const cap = this.capOf(subject.tier);
    const used = this.usedBy(subject.id, this.gs.clock.now() - ROLLING_WINDOW_MS);
    return {
      tier: subject.tier,
      applies_to: c.tier === 'tier_0' ? 'merchant_pool' : 'self',
      period: 'rolling_30d',
      cap_usd: cap === null ? null : String(cap),
      used_usd: String(used),
      remaining_usd: cap === null ? null : String(Math.max(0, cap - used)),
      as_of: this.gs.clock.iso(),
      enforced: this.gs.behaviour.tierEnforcement,
    };
  }
}

/** Exported for the KYC module: the approval guard's next_steps text. */
export { CUSTOMER_KYC_NEXT_STEPS_ACTION };
