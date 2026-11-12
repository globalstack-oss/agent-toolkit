import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary } from './globalstack/beneficiaries';
import { checkRoute } from './globalstack/catalog';
import { gs, GsError, GsUnknown, Refused } from './globalstack/gs';
import { parseAmount, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;
const CUSTOMER = process.env.GLOBALSTACK_CUSTOMER_ID!;

// ── Onboarding: the seller's own GlobalStack customer, and their verification link ──
// The ready-made code has no customer/KYC helper, so this part is ours.
const seller = async (id: string) => {
  const s = await db.get('SELECT * FROM sellers WHERE id = ?', id);
  if (!s) throw new Refused('seller not found', 404);
  return s;
};

async function findCustomer(reference: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const list = await gs<any[]>('GET', `/v1/customers?per_page=200&page=${page}`);
    const hit = list.find((c) => c.merchant_reference === reference);
    if (hit) return hit.id;
    if (list.length < 200) return null;
  }
  return null;
}

/** The seller's customer id: saved, or created once with a fixed merchant_reference (a retry after a lost answer finds it). */
async function customerFor(s: any): Promise<string> {
  const saved = await db.get('SELECT customer_id FROM seller_kyc WHERE seller_id = ?', s.id);
  if (saved) return saved.customer_id;
  const reference = `seller-${s.id}`;
  let id: string | null = null;
  try {
    const c = await gs<any>('POST', '/v1/customers', {
      body: JSON.stringify({ type: 'individual', name: s.full_name, email: s.email, country_code: 'KE', merchant_reference: reference, metadata: { seller_id: s.id } }),
      idempotencyKey: `customer-${reference}`, retry: true,
    });
    id = c.id;
  } catch (err) {
    if (!((err instanceof GsError && err.code === 'duplicate_resource') || err instanceof GsUnknown)) throw err;
    id = await findCustomer(reference);
    if (!id) throw err;
  }
  await db.run("INSERT INTO seller_kyc (seller_id, customer_id, kyc_status, updated_at) VALUES (?, ?, 'not_started', ?) ON CONFLICT DO NOTHING", s.id, id, new Date().toISOString());
  return (await db.get('SELECT customer_id FROM seller_kyc WHERE seller_id = ?', s.id)).customer_id;
}

export async function onboard(sellerId: string): Promise<{ kyc_url: string }> {
  const s = await seller(sellerId);
  const customerId = await customerFor(s);
  // The latest session's link while it is open or done; a new session otherwise (none yet, or rejected).
  try {
    const latest = await gs<any>('GET', `/v1/customers/${customerId}/verifications`);
    if (latest.status !== 'failed' && latest.hosted_url && Date.parse(latest.hosted_url_expires_at) > Date.now()) return { kyc_url: latest.hosted_url };
  } catch (err) {
    if (!(err instanceof GsError && err.status === 404)) throw err;
  }
  const session = await gs<any>('POST', `/v1/customers/${customerId}/verifications`, { body: JSON.stringify({ tier: 'tier_1' }), idempotencyKey: `kyc-${customerId}-${randomUUID()}`, retry: true });
  if (!session.hosted_url) throw new Refused('GlobalStack did not return a verification link');
  return { kyc_url: session.hosted_url };
}

/** kyc.approved / kyc.rejected: re-read the customer and store their status (a cache; payouts re-check). */
export async function onKycEvent(event: any): Promise<void> {
  if (event?.event_category !== 'kyc') return;
  const customerId = event.event_object?.customer?.id;
  if (typeof customerId !== 'string') return;
  const c = await gs<any>('GET', `/v1/customers/${encodeURIComponent(customerId)}`);
  await db.run('UPDATE seller_kyc SET kyc_status = ?, updated_at = ? WHERE customer_id = ?', String(c.kyc_status), new Date().toISOString(), customerId);
}

/** Asks GlobalStack, never a cache: approval can be withdrawn, and webhooks can be late or lost. */
async function requireApproved(sellerId: string): Promise<void> {
  const row = await db.get('SELECT customer_id FROM seller_kyc WHERE seller_id = ?', sellerId);
  if (!row) throw new Refused('the seller has not started identity verification', 403);
  const c = await gs<any>('GET', `/v1/customers/${row.customer_id}`);
  await db.run('UPDATE seller_kyc SET kyc_status = ?, updated_at = ? WHERE seller_id = ?', String(c.kyc_status), new Date().toISOString(), sellerId);
  if (c.kyc_status !== 'approved') throw new Refused(`the seller's identity verification is not approved (status: ${c.kyc_status})`, 403);
}

// ── Payouts: KES to the seller's bank, from our USDC wallet ──
export const payouts = createPayments(db, {
  kind: 'offramp',
  prepare: async (p) => {
    // target_amount: the seller receives exactly amount_kes.
    const q = await gs<any>('POST', '/v1/offramps/quotes', { body: JSON.stringify({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, target_amount: p.data.amount_kes }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    const delivers = String(q.received_amount ?? q.destination_amount);
    if (q.destination_currency !== 'KES' || toUnits(delivers) !== toUnits(p.data.amount_kes)) throw new Refused(`quote ${q.id} delivers ${delivers} ${q.destination_currency}`);
    return { quote_id: q.id, metadata: { seller_id: p.data.seller_id } };
  },
});

async function beneficiaryFor(s: any): Promise<string> {
  const key = `${s.id}:${s.bank_code}:${s.account_number}`;
  const saved = await db.get('SELECT beneficiary_id FROM payee_beneficiaries WHERE payee_key = ?', key);
  if (saved) return saved.beneficiary_id;
  const providers = await gs<any[]>('GET', '/v1/countries/KE/providers?network=bank');
  const provider = providers.find((p) => p.code === s.bank_code && p.active !== false);
  if (!provider) throw new Refused(`bank ${s.bank_name} is not supported`);
  // On OUR customer: an offramp quote needs the beneficiary on the paying wallet's customer.
  const id = await ensureBeneficiary({ type: 'fiat', name: s.full_name, account_name: s.full_name, label: `seller ${s.id}`, currency: 'KES', country_code: 'KE', network: 'bank', provider_id: provider.id, account_number: s.account_number, customer_id: CUSTOMER, merchant_reference: `seller-${s.id}-${s.bank_code}-${s.account_number}` });
  await db.run('INSERT INTO payee_beneficiaries (payee_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, id);
  return id;
}

export async function startPayout(sellerId: string, input: any) {
  const s = await seller(sellerId);
  const amount = parseAmount(input?.amount_kes, 2);
  if (!amount) throw new Refused('amount_kes must be a positive decimal', 400);
  await requireApproved(s.id);
  await checkRoute({ currency: 'KES', country_code: 'KE', direction: 'offramp', network: 'bank', amount });
  const beneficiaryId = await beneficiaryFor(s);
  const id = `po_${randomUUID().replace(/-/g, '')}`;
  await db.transaction((tx) => payouts.create(tx, id, { seller_id: s.id, amount_kes: amount, beneficiary_id: beneficiaryId }));
  void payouts.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await payouts.get(id); return p && { id: p.id, status: p.status }; };
