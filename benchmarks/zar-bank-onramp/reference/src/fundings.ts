import { randomUUID } from 'node:crypto';
import { db } from './db';
import { checkRoute } from './globalstack/catalog';
import { createCollections } from './globalstack/collections';
import { Refused } from './globalstack/gs';
import { fromUnits, parseAmount, toUnits } from './globalstack/money';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;

export const fundings = createCollections(db, {
  quoteBody: (c) => ({ wallet_id: WALLET, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: c.data.amount_zar }),
  onCredited: async (c, amount, _o, tx) => {
    const b = await tx.get('SELECT usdc_balance FROM businesses WHERE id = ?', c.data.business_id);
    await tx.run('UPDATE businesses SET usdc_balance = ? WHERE id = ?', fromUnits(toUnits(b.usdc_balance) + toUnits(amount)), c.data.business_id);
  },
});

const bankDetails = (o: any) => {
  const d = o?.deposit_instruction ?? {};
  return { account_name: d.accountName, account_number: d.accountNumber, bank_name: d.bankName, bank_code: d.bankCode, reference: d.depositReference, expires_at: d.expiresAt };
};

export async function startFunding(input: any) {
  const biz = await db.get('SELECT id FROM businesses WHERE id = ?', String(input?.business_id ?? ''));
  if (!biz) throw new Refused('unknown business', 404);
  const amount = parseAmount(input?.amount_zar, 2);
  if (!amount) throw new Refused('amount_zar must be a positive decimal', 400);
  await checkRoute({ currency: 'ZAR', country_code: 'ZA', direction: 'onramp', network: 'bank', amount });
  const c = await fundings.start(`fd_${randomUUID()}`, { business_id: biz.id, amount_zar: amount });
  if (!c.onramp) throw new Refused('GlobalStack has not confirmed the funding yet; try again shortly', 503);
  return { id: c.id, bank_details: bankDetails(c.onramp) };
}
export const view = async (id: string) => { const c = await fundings.get(id); return c && { id: c.id, status: c.status, bank_details: bankDetails(c.onramp) }; };
