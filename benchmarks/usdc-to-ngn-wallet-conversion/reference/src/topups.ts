import { randomUUID } from 'node:crypto';
import { db } from './db';
import { gs, Refused } from './globalstack/gs';
import { parseAmount, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';

const USDC = process.env.GLOBALSTACK_WALLET_ID!;
const NGN = process.env.GLOBALSTACK_NGN_WALLET_ID!;

export const topups = createPayments(db, {
  kind: 'conversion',
  prepare: async (p) => {
    const q = await gs<any>('POST', '/v1/conversions/quotes', { body: JSON.stringify({ source_wallet_id: USDC, destination_wallet_id: NGN, target_amount: p.data.amount_ngn }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    const delivers = String(q.received_amount ?? q.destination_amount);
    if (q.destination_wallet_id !== NGN || toUnits(delivers) !== toUnits(p.data.amount_ngn)) throw new Refused(`quote ${q.id} delivers ${delivers} into ${q.destination_wallet_id}`);
    return { quote_id: q.id, source_currency: 'USDC', destination_currency: 'NGN' };
  },
});

export async function startTopup(input: any) {
  const amount = parseAmount(input?.amount_ngn, 2);
  if (!amount) throw new Refused('amount_ngn must be a positive decimal', 400);
  const id = `ngt_${randomUUID().replace(/-/g, '')}`;
  await db.transaction((tx) => topups.create(tx, id, { amount_ngn: amount }));
  void topups.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await topups.get(id); return p && { id: p.id, status: p.status }; };
