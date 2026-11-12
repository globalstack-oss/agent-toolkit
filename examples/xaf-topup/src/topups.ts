import { randomUUID } from 'node:crypto';
import { db } from './db';
import { checkRoute, findProvider } from './globalstack/catalog';
import { createCollections } from './globalstack/collections';
import { Refused } from './globalstack/gs';
import { fromUnits, parseAmount, toUnits } from './globalstack/money';
import { firstRequest, requestHash } from './idempotency';

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

/**
 * `userId` comes from the caller's login, never from the body. `replayed`: an earlier request from this user with
 * the same Idempotency-Key started it, and `result` is that first answer.
 */
export async function startTopup(userId: string, input: any, key?: string): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  const hash = requestHash({ amount_xaf: input?.amount_xaf, phone: input?.phone });
  const first = key === undefined ? null : await firstRequest(db, userId, key, hash);
  if (first) return { replayed: true, result: await firstAnswer(first) };
  const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new Refused('unknown user', 404);
  const amount = parseAmount(input?.amount_xaf, 0);
  if (!amount) throw new Refused('amount_xaf must be a whole number', 400);
  const phone = String(input?.phone ?? user.phone).replace(/[\s-]/g, '');
  if (!/^\+2376\d{8}$/.test(phone)) throw new Refused('phone must be a Cameroon mobile number', 400);
  await checkRoute({ currency: 'XAF', country_code: 'CM', direction: 'onramp', network: 'mobile_money', amount });
  const provider = await findProvider('CM', 'mobile_money', /^6(?:9|5[5-9])/.test(phone.slice(4)) ? /orange/i : /mtn/i);
  const id = `tp_${randomUUID()}`;
  if (key !== undefined) {
    // The collection engine saves its own row, so the key claims the id first: a second request with the same
    // key finds it here and does not start a second collection.
    const won = await db.transaction(async (tx) => {
      const earlier = await firstRequest(tx, userId, key, hash);
      if (!earlier) await tx.run('INSERT INTO idempotency_keys (user_id, key, request_hash, resource_id) VALUES (?, ?, ?, ?)', userId, key, hash, id);
      return earlier;
    });
    if (won) return { replayed: true, result: await firstAnswer(won) };
  }
  let c;
  try {
    c = await topups.start(id, { user_id: userId, amount, phone, provider_id: provider.id, full_name: user.full_name });
  } catch (err) {
    // Refused: nothing was charged and the collection is failed, so the key may be used again.
    if (key !== undefined && err instanceof Refused) await db.run('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?', userId, key);
    throw err;
  }
  const di = c.onramp?.deposit_instruction ?? {};
  const instructions = `Approve the ${provider.name} payment request on ${phone} for ${amount} XAF.${di.instructions ? ` ${di.instructions}` : ''}`;
  const result = { id: c.id, instructions };
  if (key !== undefined) await db.run('UPDATE idempotency_keys SET response = ? WHERE user_id = ? AND key = ?', JSON.stringify(result), userId, key);
  return { replayed: false, result };
}

/** The first request's answer; while that request is still starting the collection, its id and status. */
async function firstAnswer(first: { id: string; response: any }): Promise<Record<string, unknown>> {
  return first.response ?? { id: first.id, status: (await topups.get(first.id))?.status ?? 'starting' };
}

/** The top-up, only when it belongs to `userId`. */
export const view = async (userId: string, id: string) => {
  const c = await topups.get(id);
  return c && c.data.user_id === userId ? { id: c.id, status: c.status } : null;
};
