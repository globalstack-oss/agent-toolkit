import pg from 'pg';
import { postgresDb } from './globalstack/types';
export const db = postgresDb(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
export const ready = db.exec('CREATE TABLE IF NOT EXISTS payee_beneficiaries (payee_key TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL)');
