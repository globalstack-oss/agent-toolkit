import { DatabaseSync } from 'node:sqlite';
import { sqliteDb } from './globalstack/types';
const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? 'data.db');
sqlite.exec('PRAGMA busy_timeout = 5000');
export const db = sqliteDb(sqlite);
sqlite.exec('CREATE TABLE IF NOT EXISTS payee_beneficiaries (payee_key TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL)');
sqlite.exec('CREATE TABLE IF NOT EXISTS withdrawal_returns (movement_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, refunded_at TEXT NOT NULL)');
