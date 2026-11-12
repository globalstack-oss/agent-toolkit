import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary } from './globalstack/beneficiaries';
import { checkRoute } from './globalstack/catalog';
import { Refused } from './globalstack/gs';
import { fromUnits, parseAmount, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';
import type { Db } from './globalstack/types';

const WALLET = process.env.GLOBALSTACK_WALLET_ID!;
const CUSTOMER = process.env.GLOBALSTACK_CUSTOMER_ID!;
const balance = async (q: Db, userId: string) => toUnits((await q.get('SELECT usdc_balance FROM users WHERE id = ?', userId)).usdc_balance);
const setBalance = (q: Db, userId: string, units: bigint) => q.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(units), userId);

export const withdrawals = createPayments(db, {
  kind: 'transfer',
  prepare: async (p) => ({ wallet_id: WALLET, beneficiary_id: p.data.beneficiary_id, amount: p.data.amount, metadata: { user_id: p.data.user_id } }),
  onFailed: async (p, _reason, tx) => { await setBalance(tx, p.data.user_id, (await balance(tx, p.data.user_id)) + toUnits(p.data.amount)); },
});

export async function startWithdrawal(input: any): Promise<string> {
  const userId = typeof input?.user_id === 'string' ? input.user_id : '';
  if (!userId) throw new Refused('user_id is required', 400);
  const amount = parseAmount(input?.amount_usdc, 2);
  if (!amount) throw new Refused('amount_usdc must be a positive decimal with at most 2 decimals', 400);
  const address = typeof input?.address === 'string' ? input.address : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Refused('address must be a Base address', 400);
  const user = await db.get('SELECT full_name, usdc_balance FROM users WHERE id = ?', userId);
  if (!user) throw new Refused('unknown user', 404);
  if (toUnits(user.usdc_balance) < toUnits(amount)) throw new Refused('insufficient balance');
  await checkRoute({ currency: 'USDC', direction: 'transfer', network: 'base', amount });
  const key = address.toLowerCase();
  let beneficiaryId = (await db.get('SELECT beneficiary_id FROM crypto_beneficiaries WHERE address_key = ?', key))?.beneficiary_id;
  if (!beneficiaryId) {
    beneficiaryId = await ensureBeneficiary({ type: 'crypto', name: user.full_name, label: `user ${userId}`, currency: 'USDC', network: 'base', address, customer_id: CUSTOMER, merchant_reference: `usdc-base-${key}` });
    await db.run('INSERT INTO crypto_beneficiaries (address_key, beneficiary_id) VALUES (?, ?) ON CONFLICT DO NOTHING', key, beneficiaryId);
  }
  const id = `cwd_${randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {
    const b = await balance(tx, userId);
    if (b < toUnits(amount)) throw new Refused('insufficient balance');
    await setBalance(tx, userId, b - toUnits(amount));
    await withdrawals.create(tx, id, { user_id: userId, amount, beneficiary_id: beneficiaryId });
  });
  void withdrawals.drive(id);
  return id;
}
