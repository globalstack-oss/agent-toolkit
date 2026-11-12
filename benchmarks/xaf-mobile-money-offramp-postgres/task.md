## Task

Our users in Cameroon hold USDC with us and want to cash out to their mobile money wallet (MTN Mobile Money or Orange Money) in XAF. Build the payout flow: a user asks to pay out an amount of USDC, we debit their balance and send the XAF to their phone. The USDC comes from our USDC wallet; each user's balance, phone and operator are in the `users` table.

This app uses Postgres, not SQLite: `src/db.ts` exports a `pg` Pool connected to `DATABASE_URL` (the `pg` package is installed). The tables in `db/schema.sql` already exist in that database.

## Interface

- `POST /payouts` with JSON `{ "user_id": "...", "amount_usdc": "20.00" }`. Answer `201` with `{ "id": "..." }` when the payout has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
