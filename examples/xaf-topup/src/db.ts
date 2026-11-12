import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sqliteDb } from './globalstack/types';
import { IDEMPOTENCY_TABLE } from './idempotency';
import { SESSIONS_TABLE } from './sessions';

const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? 'data.db');
sqlite.exec('PRAGMA busy_timeout = 5000');
// Demo only: a new database gets the users table and a few users. Your app already has its own.
if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) {
  sqlite.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8'));
}
sqlite.exec(SESSIONS_TABLE);
sqlite.exec(IDEMPOTENCY_TABLE);
export const db = sqliteDb(sqlite);
