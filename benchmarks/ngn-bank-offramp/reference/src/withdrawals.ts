import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary } from './globalstack/beneficiaries';
import { checkRoute } from './globalstack/catalog';
import { gs, Refused } from './globalstack/gs';
import { fromUnits, parseAmount, roundDown, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;
const CUSTOMER = process.env.GLOBALSTACK_CUSTOMER_ID!;
import type { Db } from './globalstack/types';
const balance = async (q: Db, id: string) => toUnits((await q.get('SELECT usdc_balance FROM users WHERE id = ?', id)).usdc_balance);
const setBalance = (q: Db, id: string, u: bigint) => q.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(u), id);

export const withdrawals = createPayments(db, {
  kind: 'offramp',
  prepare: async (p) => {
    const q = await gs<any>('POST', '/v1/offramps/quotes', { body: JSON.stringify({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, source_amount: p.data.amount }), idempotencyKey: `quote-${randomUUID()}`, retry: true });
    return { quote_id: q.id, metadata: { user_id: p.data.user_id } };
  },
  onFailed: async (p, _r, tx) => { await setBalance(tx, p.data.user_id, (await balance(tx, p.data.user_id)) + toUnits(p.data.amount)); },
});

async function beneficiaryFor(user: any): Promise<string> {
  const key = `${user.id}:${user.bank_code}:${user.account_number}`;
  const saved = await db.get('SELECT beneficiary_id FROM payee_beneficiaries WHERE payee_key = ?', key);
  if (saved) return saved.beneficiary_id;
  const providers = await gs<any[]>('GET', '/v1/countries/NG/providers?network=bank');
  const provider = providers.find((p) => p.code === user.bank_code && p.active !== false);
  if (!provider) throw new Refused(`bank ${user.bank_name} is not supported`);
  const id = await ensureBeneficiary({ type: 'fiat', name: user.full_name, label: `user ${user.id}`, currency: 'NGN', country_code: 'NG', network: 'bank', provider_id: provider.id, account_number: user.account_number, customer_id: CUSTOMER, merchant_reference: `ngn-${user.id}-${user.bank_code}-${user.account_number}` });
  await db.run('INSERT INTO payee_beneficiaries (payee_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, id);
  return id;
}

export async function startWithdrawal(input: any) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', String(input?.user_id ?? ''));
  if (!user) throw new Refused('unknown user', 404);
  const all = input?.amount === 'all';
  if (!all && !parseAmount(input?.amount, 6)) throw new Refused('amount must be a decimal string or "all"', 400);
  await checkRoute({ currency: 'NGN', country_code: 'NG', direction: 'offramp', network: 'bank' });
  const beneficiaryId = await beneficiaryFor(user);
  const id = `wd_${randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {
    const b = await balance(tx, user.id);
    const amount = roundDown(all ? fromUnits(b) : String(input.amount), 2); // USDC sent is rounded down to 2 decimals
    if (toUnits(amount) <= 0n) throw new Refused('nothing to withdraw');
    if (toUnits(amount) > b) throw new Refused('insufficient balance');
    await setBalance(tx, user.id, b - toUnits(amount));
    await withdrawals.create(tx, id, { user_id: user.id, amount, beneficiary_id: beneficiaryId });
  });
  void withdrawals.drive(id);
  return { id };
}
export const view = async (id: string) => { const p = await withdrawals.get(id); return p && { id: p.id, status: p.status }; };
