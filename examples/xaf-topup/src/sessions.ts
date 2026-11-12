// Stands in for your app's real login: a token per user in a sessions table. Your app already knows who is
// calling from its own login (a session cookie, a JWT); use that instead and drop this file.
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { Refused } from './globalstack/gs';
import type { Db } from './globalstack/types';

export const SESSIONS_TABLE = 'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL)';

/** The id of the user calling, from `Authorization: Bearer <token>`. Missing or unknown: 401. */
export async function currentUser(db: Db, req: Request): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1];
  const row = token ? await db.get('SELECT user_id FROM sessions WHERE token = ?', token) : null;
  if (!row) throw new Refused('log in first: send Authorization: Bearer <token>', 401);
  return row.user_id;
}

/** Demo setup: a token for each user that has none. Returns user id -> token. */
export async function demoSessions(db: Db): Promise<Record<string, string>> {
  for (const u of await db.all('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM sessions)')) {
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', randomBytes(24).toString('hex'), u.id);
  }
  return Object.fromEntries((await db.all('SELECT user_id, token FROM sessions')).map((r: any) => [r.user_id, r.token]));
}
