import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary } from './globalstack/beneficiaries';
import { checkRoute, findProvider } from './globalstack/catalog';
import { gs, Refused } from './globalstack/gs';
import { fromUnits, parseAmount, roundDown, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';
import type { Db } from './globalstack/types';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;
const CUSTOMER = process.env.GLOBALSTACK_CUSTOMER_ID!;
const balance = async (q: Db, id: string) => toUnits((await q.get('SELECT usdc_balance FROM users WHERE id = ?', id)).usdc_balance);
const setBalance = (q: Db, id: string, u: bigint) => q.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(u), id);
const refund = async (q: Db, p: { data: any }) => setBalance(q, p.data.user_id, (await balance(q, p.data.user_id)) + toUnits(p.data.amount));

export const withdrawals = createPayments(db, {
  kind: 'offramp',
  prepare: async (p) => {
    const q = await gs<any>('POST', '/v1/offramps/quotes', { body: JSON.stringify({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, source_amount: p.data.amount }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    return { quote_id: q.id, metadata: { user_id: p.data.user_id } };
  },
  onFailed: async (p, _r, tx) => { await refund(tx, p); },
});

// ── Returned after success ──
// The engine only drives pending payments, so a payout returned after it completed is handled here:
// re-read the offramp, then refund once (keyed by the movement id) and mark the payment failed.
const RETURNS_ENABLED = true;
export async function handleReturned(offrampId: string): Promise<void> {
  if (!RETURNS_ENABLED) return;
  const m = await gs<any>('GET', `/v1/offramps/${encodeURIComponent(offrampId)}`);
  if (m?.status !== 'returned' || typeof m.reference !== 'string') return;
  await db.transaction(async (tx) => {
    const a = await tx.get('SELECT payment_id, attempt FROM gs_payment_attempts WHERE reference = ?', m.reference);
    if (!a) return; // not ours
    const p = await withdrawals.get(a.payment_id, tx);
    if (!p || p.status !== 'completed') return; // pending: the engine refunds; failed: already refunded
    if (!(await tx.run('INSERT INTO withdrawal_returns (movement_id, payment_id, refunded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', m.id, p.id, new Date().toISOString()))) return;
    await refund(tx, p);
    await tx.run("UPDATE gs_payments SET status = 'failed', failure_reason = 'returned', updated_at = ? WHERE id = ?", new Date().toISOString(), p.id);
    console.error(`ALERT withdrawal ${p.id}: offramp ${m.id} returned after success; refunded ${p.data.amount} USDC to ${p.data.user_id}`);
  });
}
export async function onReturnEvent(event: any): Promise<void> {
  if (event?.event_category === 'offramp' && String(event.event_type ?? '').endsWith('.returned') && typeof event.event_object?.id === 'string') await handleReturned(event.event_object.id);
}
/** Webhooks can be lost: also look for returned offramps every 10 minutes. */
export function watchReturns(): void {
  const sweep = async () => {
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    for (let page = 1; page <= 20; page++) {
      const list = await gs<any[]>('GET', `/v1/offramps?status=returned&created_after=${encodeURIComponent(since)}&per_page=100&page=${page}`);
      for (const m of list) await handleReturned(m.id);
      if (list.length < 100) break;
    }
  };
  const run = () => void sweep().catch((err) => console.error(`returns sweep: ${err.message}`));
  run();
  setInterval(run, 10 * 60_000);
}

async function beneficiaryFor(user: any): Promise<string> {
  const key = `${user.id}:${user.bank_code}:${user.account_number}`;
  const saved = await db.get('SELECT beneficiary_id FROM payee_beneficiaries WHERE payee_key = ?', key);
  if (saved) return saved.beneficiary_id;
  const providers = await gs<any[]>('GET', '/v1/countries/KE/providers?network=bank');
  const provider = providers.find((p) => p.code === user.bank_code && p.active !== false);
  if (!provider) throw new Refused(`bank ${user.bank_name} is not supported`);
  const id = await ensureBeneficiary({ type: 'fiat', name: user.full_name, account_name: user.full_name, label: `user ${user.id}`, currency: 'KES', country_code: 'KE', network: 'bank', provider_id: provider.id, account_number: user.account_number, customer_id: CUSTOMER, merchant_reference: `kes-${user.id}-${user.bank_code}-${user.account_number}` });
  await db.run('INSERT INTO payee_beneficiaries (payee_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, id);
  return id;
}
void findProvider;

export async function startWithdrawal(input: any) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', String(input?.user_id ?? ''));
  if (!user) throw new Refused('unknown user', 404);
  const raw = parseAmount(input?.amount_usdc, 6);
  if (!raw) throw new Refused('amount_usdc must be a positive decimal string', 400);
  const amount = roundDown(raw, 2); // USDC sent is rounded down to 2 decimals
  if (toUnits(amount) <= 0n) throw new Refused('amount too small', 400);
  await checkRoute({ currency: 'KES', country_code: 'KE', direction: 'offramp', network: 'bank' });
  const beneficiaryId = await beneficiaryFor(user);
  const id = `wd_${randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {
    const b = await balance(tx, user.id);
    if (toUnits(amount) > b) throw new Refused('insufficient balance');
    await setBalance(tx, user.id, b - toUnits(amount));
    await withdrawals.create(tx, id, { user_id: user.id, amount, beneficiary_id: beneficiaryId });
  });
  void withdrawals.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await withdrawals.get(id); return p && { id: p.id, status: p.status }; };
