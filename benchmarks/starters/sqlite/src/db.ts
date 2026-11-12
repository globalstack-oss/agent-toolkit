import { DatabaseSync } from 'node:sqlite';

// The app's existing database. The tables in db/schema.sql already exist and hold real data.
// You may add your own tables.
export const db = new DatabaseSync(process.env.DATABASE_PATH ?? 'data.db');
