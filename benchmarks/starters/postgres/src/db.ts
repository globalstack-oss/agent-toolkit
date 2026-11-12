import pg from 'pg';

// The app's existing Postgres database. The tables in db/schema.sql already exist and hold real data.
// You may add your own tables.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
