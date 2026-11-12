import { DatabaseSync } from 'node:sqlite';
import { sqliteDb } from './globalstack/types';
const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? 'data.db');
sqlite.exec('PRAGMA busy_timeout = 5000');
export const db = sqliteDb(sqlite);
