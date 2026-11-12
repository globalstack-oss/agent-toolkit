import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary } from './globalstack/beneficiaries';
import { checkRoute, findProvider } from './globalstack/catalog';
import { gs, Refused } from './globalstack/gs';
import { parseAmount, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;
const CUSTOMER = process.env.GLOBALSTACK_CUSTOMER_ID!;

export const payouts = createPayments(db, {
  kind: 'offramp',
  prepare: async (p) => {
    // target_amount: the freelancer receives exactly amount_kes.
    const q = await gs<any>('POST', '/v1/offramps/quotes', { body: JSON.stringify({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, target_amount: p.data.amount_kes }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    const delivers = String(q.received_amount ?? q.destination_amount);
    if (q.destination_currency !== 'KES' || toUnits(delivers) !== toUnits(p.data.amount_kes)) throw new Refused(`quote ${q.id} delivers ${delivers} ${q.destination_currency}`);
    return { quote_id: q.id, metadata: { freelancer_id: p.data.freelancer_id } };
  },
});

export async function startPayout(input: any) {
  const f = await db.get('SELECT * FROM freelancers WHERE id = ?', String(input?.freelancer_id ?? ''));
  if (!f) throw new Refused('freelancer not found', 404);
  const amount = parseAmount(input?.amount_kes, 2);
  if (!amount) throw new Refused('amount_kes must be a positive decimal', 400);
  const phone = String(f.mpesa_phone).replace(/[\s-]/g, '');
  if (!/^\+254[17]\d{8}$/.test(phone)) throw new Refused('the freelancer has no valid M-Pesa number');
  await checkRoute({ currency: 'KES', country_code: 'KE', direction: 'offramp', network: 'mobile_money', amount });
  const key = `${f.id}:${phone}`;
  let ben = (await db.get('SELECT beneficiary_id FROM payee_beneficiaries WHERE payee_key = ?', key))?.beneficiary_id;
  if (!ben) {
    const provider = await findProvider('KE', 'mobile_money', /m-?pesa/i);
    ben = await ensureBeneficiary({ type: 'fiat', name: f.name, account_name: f.name, label: `freelancer ${f.id}`, currency: 'KES', country_code: 'KE', network: 'mobile_money', provider_id: provider.id, account_number: phone, customer_id: CUSTOMER, merchant_reference: `mpesa-${f.id}-${phone.slice(1)}` });
    await db.run('INSERT INTO payee_beneficiaries (payee_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, ben);
  }
  const id = `po_${randomUUID().replace(/-/g, '')}`;
  await db.transaction((tx) => payouts.create(tx, id, { freelancer_id: f.id, amount_kes: amount, beneficiary_id: ben }));
  void payouts.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await payouts.get(id); return p && { id: p.id, status: p.status === 'completed' ? 'paid' : p.status }; };
