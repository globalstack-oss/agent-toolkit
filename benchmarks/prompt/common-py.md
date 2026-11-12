You are a backend engineer at a fintech. Your company just got GlobalStack API access. Write production-ready Python for the task below, inside the existing app in your current folder. Also write a short NOTES.md listing assumptions, open questions for GlobalStack, and anything you decided NOT to build and why.

## The app you work in

- A FastAPI app on Python 3.13. Our deploy runs `npm start` and `npm run setup` (the scripts in `package.json`; do not change them). `npm start` runs the server: `.venv/bin/python -m app.main` (`app/main.py`, uvicorn). `npm run setup` runs `app/setup.py` once per environment, after deploy and before the server starts.
- Installed packages, in `.venv`: fastapi, uvicorn, httpx, svix, pydantic. You cannot install other packages. The whole standard library is available (sqlite3, decimal, uuid, hmac...).
- Database: SQLite through the standard `sqlite3` module, opened in `app/db.py`. The tables in `db/schema.sql` already exist and hold production data. You may add tables.
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
