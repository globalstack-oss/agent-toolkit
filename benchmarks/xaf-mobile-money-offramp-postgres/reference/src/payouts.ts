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
// usdc_balance is NUMERIC: pg returns it as a string; never let it become a float.
const balance = async (q: Db, id: string) => toUnits(String((await q.get('SELECT usdc_balance::text AS b FROM users WHERE id = ?', id)).b));
const setBalance = (q: Db, id: string, u: bigint) => q.run('UPDATE users SET usdc_balance = ?::numeric WHERE id = ?', fromUnits(u), id);

export const payouts = createPayments(db, {
  kind: 'offramp',
  prepare: async (p) => {
    const q = await gs<any>('POST', '/v1/offramps/quotes', { body: JSON.stringify({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, source_amount: p.data.amount }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    return { quote_id: q.id, metadata: { user_id: p.data.user_id } };
  },
  onFailed: async (p, _r, tx) => { await setBalance(tx, p.data.user_id, (await balance(tx, p.data.user_id)) + toUnits(p.data.amount)); },
});

async function beneficiaryFor(user: any): Promise<string> {
  const phone = String(user.phone).replace(/[\s-]/g, '');
  if (!/^\+237\d{9}$/.test(phone)) throw new Refused('the user has no valid Cameroonian mobile number');
  const key = `${user.id}:${user.operator}:${phone}`;
  const saved = await db.get('SELECT beneficiary_id FROM payee_beneficiaries WHERE payee_key = ?', key);
  if (saved) return saved.beneficiary_id;
  const provider = await findProvider('CM', 'mobile_money', user.operator === 'ORANGE' ? /orange/i : /mtn/i);
  const id = await ensureBeneficiary({ type: 'fiat', name: user.full_name, account_name: user.full_name, label: `user ${user.id}`, currency: 'XAF', country_code: 'CM', network: 'mobile_money', provider_id: provider.id, account_number: phone, customer_id: CUSTOMER, merchant_reference: `xaf-${user.id}-${user.operator}-${phone.slice(1)}` });
  await db.run('INSERT INTO payee_beneficiaries (payee_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, id);
  return id;
}

export async function startPayout(input: any) {
  const user = await db.get('SELECT id, full_name, phone, operator FROM users WHERE id = ?', String(input?.user_id ?? ''));
  if (!user) throw new Refused('unknown user', 404);
  const raw = parseAmount(input?.amount_usdc, 6);
  if (!raw) throw new Refused('amount_usdc must be a positive decimal string', 400);
  const amount = roundDown(raw, 2);
  if (toUnits(amount) <= 0n) throw new Refused('amount too small', 400);
  await checkRoute({ currency: 'XAF', country_code: 'CM', direction: 'offramp', network: 'mobile_money' });
  const beneficiaryId = await beneficiaryFor(user);
  const id = `po_${randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {
    const b = await balance(tx, user.id);
    if (toUnits(amount) > b) throw new Refused('insufficient balance');
    await setBalance(tx, user.id, b - toUnits(amount));
    await payouts.create(tx, id, { user_id: user.id, amount, beneficiary_id: beneficiaryId });
  });
  void payouts.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await payouts.get(id); return p && { id: p.id, status: p.status }; };
