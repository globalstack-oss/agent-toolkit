You are a backend engineer at a fintech. Your company just got GlobalStack API access. Write production-ready TypeScript for the task below, inside the existing app in your current folder. Also write a short NOTES.md listing assumptions, open questions for GlobalStack, and anything you decided NOT to build and why.

## The app you work in

- `npm start` runs the server (`src/server.ts`, Express). `npm run setup` runs once per environment, after deploy and before the server starts (`src/setup.ts`).
- Installed packages: express, svix, tsx, typescript. You cannot install other packages. Node 22 built-ins are available (fetch, node:crypto, node:sqlite).
- Database: SQLite through `node:sqlite`, opened in `src/db.ts`. The tables in `db/schema.sql` already exist and hold production data. You may add tables.
- Configuration comes from environment variables:
  - `PORT`: the port to listen on
  - `DATABASE_PATH`: the SQLite file
  - `PUBLIC_URL`: this service's public base URL, as seen from the internet
  - `GLOBALSTACK_BASE_URL`: the GlobalStack API base URL
  - `GLOBALSTACK_SECRET_KEY`: the secret key
  - `GLOBALSTACK_CUSTOMER_ID`: the GlobalStack customer that owns our wallets (our business, verified)
  - `GLOBALSTACK_WALLET_ID`: our USDC wallet at GlobalStack
  - In our test and staging environments, `PUBLIC_URL` and `GLOBALSTACK_BASE_URL` are plain `http://` URLs on
    localhost. Production uses `https://`. The app must start with either.
