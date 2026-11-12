import { randomUUID } from 'node:crypto';
import { db } from './db';
import { checkRoute, findProvider } from './globalstack/catalog';
import { createCollections } from './globalstack/collections';
import { Refused } from './globalstack/gs';
import { fromUnits, parseAmount, toUnits } from './globalstack/money';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;

export const topups = createCollections(db, {
  quoteBody: (c) => ({
    wallet_id: WALLET, source_currency: 'XAF', country_code: 'CM', source_network: 'mobile_money', source_amount: c.data.amount,
    phone_number: c.data.phone, provider_id: c.data.provider_id, full_name: c.data.full_name,
  }),
  onCredited: async (c, amount, _o, tx) => {
    const u = await tx.get('SELECT usdc_balance FROM users WHERE id = ?', c.data.user_id);
    await tx.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(toUnits(u.usdc_balance) + toUnits(amount)), c.data.user_id);
  },
});

export async function startTopup(input: any) {
  const userId = typeof input?.user_id === 'string' ? input.user_id : '';
  const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new Refused('unknown user', 404);
  const amount = parseAmount(input?.amount_xaf, 0);
  if (!amount) throw new Refused('amount_xaf must be a whole number', 400);
  const phone = String(input?.phone ?? user.phone).replace(/[\s-]/g, '');
  if (!/^\+2376\d{8}$/.test(phone)) throw new Refused('phone must be a Cameroon mobile number', 400);
  await checkRoute({ currency: 'XAF', country_code: 'CM', direction: 'onramp', network: 'mobile_money', amount });
  const provider = await findProvider('CM', 'mobile_money', /^6(?:9|5[5-9])/.test(phone.slice(4)) ? /orange/i : /mtn/i);
  const c = await topups.start(`tp_${randomUUID()}`, { user_id: userId, amount, phone, provider_id: provider.id, full_name: user.full_name });
  const di = c.onramp?.deposit_instruction ?? {};
  const instructions = `Approve the ${provider.name} payment request on ${phone} for ${amount} XAF.${di.instructions ? ` ${di.instructions}` : ''}`;
  return { id: c.id, instructions };
}
