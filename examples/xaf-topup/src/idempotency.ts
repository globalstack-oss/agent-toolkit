// The optional Idempotency-Key header on the create route: a client that sends its request again (after a timeout
// or a lost response) with the same key gets the first answer back, and no second payment is created. Each key is
// saved per user, with a hash of its request and the id it created, in the same database as the payment.
import { createHash } from 'node:crypto';
import { Refused } from './globalstack/gs';
import type { Db } from './globalstack/types';

export const IDEMPOTENCY_TABLE = 'CREATE TABLE IF NOT EXISTS idempotency_keys (user_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, response TEXT, PRIMARY KEY (user_id, key))';

/** Undefined without the header. Refuses an empty or very long key. */
export function idempotencyKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (header.length < 1 || header.length > 255) throw new Refused('Idempotency-Key must be 1 to 255 characters', 400);
  return header;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as any)[k])]))
    : v;
export const requestHash = (body: unknown) => createHash('sha256').update(JSON.stringify(canonical(body ?? null))).digest('hex');

/** What this user's first request with this key created, or null for a new key. A key sent with another request: 409. */
export async function firstRequest(q: Db, userId: string, key: string, hash: string): Promise<{ id: string; response: any } | null> {
  const row = await q.get('SELECT request_hash, resource_id, response FROM idempotency_keys WHERE user_id = ? AND key = ?', userId, key);
  if (!row) return null;
  if (row.request_hash !== hash) throw new Refused('this Idempotency-Key was already used with a different request', 409);
  return { id: row.resource_id, response: row.response ? JSON.parse(row.response) : null };
}
