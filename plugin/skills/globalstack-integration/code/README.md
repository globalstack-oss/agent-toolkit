# GlobalStack reference code

Tested TypeScript for the parts of a GlobalStack integration that are easy to get wrong: retries, lost
responses, provider errors, crashes, rate limits, duplicate or forged webhooks, and webhooks that never come.
Every file was run against each of those failures and kept the books equal to GlobalStack's ledger.

**Copy these files into your app unchanged (e.g. `src/globalstack/`). Build your flow on top of them. Do not
rewrite the retry, lookup, reference or webhook logic: that is where integrations lose money.**

Do not edit them either, even to make them stricter. Each rule was tested against a failure. Edits that looked
safer, such as never resending after an unclear answer, left payments stuck. If something looks wrong, write it in
your notes for the developer and keep the file as it is. One edit is allowed: if your build needs file extensions
on relative imports (`"moduleResolution": "NodeNext"`, or Node running `.ts` files itself), add `.js` (or `.ts`)
to the `./...` imports.

After a plugin update, `build_check_acceptance` compares your copies with this folder and lists the files that
changed. Copy those in again, keeping the import extensions if you added them.

| File | What it does |
| - | - |
| `gs.ts` | API client: auth, envelope, safe retries, `GsError` / `GsUnknown` / `Refused`, `findByReference`, `configureGlobalStack`, `onGlobalStackAlert`. |
| `money.ts` | Exact decimal strings: `toUnits`, `fromUnits`, `parseAmount`, `roundDown`, `toSignedUnits`. Never use floats. |
| `catalog.ts` | `checkRoute` before every flow (open, access granted), `findProvider`, `requestAccessIfNeeded`. |
| `beneficiaries.ts` | `payeeReference` and `ensureBeneficiary`: one beneficiary per set of payout details, found again after a lost response. |
| `payments.ts` | Money OUT engine (offramp, conversion, transfer): references, attempts, retries, refunds, poller. |
| `collections.ts` | Money IN engine (onramp): one onramp per collection, credit `received_amount` once on success, poller. |
| `deposits.ts` | Crypto deposits: one address per user and network (`details.address`), credit each settled deposit once, poller. |
| `webhooks.ts` | `ensureWebhook` for setup; `webhookHandler` (Express) or `webhookReceiver` (any framework): Svix signature, dedupe, 2xx after commit. |
| `types.ts` | `Db`, `sqliteDb(...)` and `postgresDb(...)`: one async database interface for the engines. Always copy it. |

Copy only what you use: `gs.ts`, `money.ts` and `types.ts` always; `payments.ts` for money out; `collections.ts`
for money in (onramp); `deposits.ts` and `catalog.ts` for crypto deposits to an address; `webhooks.ts` for
webhooks; `beneficiaries.ts` and `catalog.ts` for payouts to people.

**App in another language?** Port the files you need one for one, into the app's own framework and database
layer. Keep what the tests rely on: the same states and tables, each state change re-checked inside a database
transaction, references built from your record id plus an attempt number, a lookup by reference after any unclear
answer, no float amounts (integer units or a decimal type), webhooks verified with your language's Svix library on
the raw body and deduplicated on `event_id`, and the poller. Do not simplify them. Keep the User-Agent, with
your language in place of `node`: `globalstack-reference-python/2`. A port is untested until it passes every fault
of the failure sandbox (the `globalstack-testing` skill), which works with any language. Start each ported file
with the two license lines of the file it comes from.

## What it needs

- Node 22 or later (Node 22.13 or later for `node:sqlite`), and the `svix` package (1.x or 2.x).
- SQLite (`node:sqlite` or `better-sqlite3`) or Postgres (`pg`), wrapped once:

```ts
// db.ts: one of these two
import { DatabaseSync } from 'node:sqlite';
import { sqliteDb } from './globalstack/types';
const handle = new DatabaseSync(process.env.DATABASE_PATH ?? 'data.db');
handle.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');   // needed when several processes share the file
export const db = sqliteDb(handle);

// import pg from 'pg';
// import { postgresDb } from './globalstack/types';
// export const db = postgresDb(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
```

- A server process that keeps running: the engines finish payments in the background and poll every minute. On
  serverless or scale-to-zero hosting (Lambda, Vercel functions, Cloud Run with no minimum instance), call each
  engine's `reconcile()` from a scheduled job every minute, and `await payouts.drive(id)` before you answer.
- The key: `GLOBALSTACK_SECRET_KEY` (or `GLOBALSTACK_API_KEY`), and `GLOBALSTACK_BASE_URL` to point at the failure
  sandbox. They are read at each call, so loading a `.env` file after the imports is fine. To pass them another
  way, call `configureGlobalStack({ secretKey, baseUrl })` once at startup. The key is sent only to an https base URL, or
  http to localhost, 127.0.0.1 or ::1: any other base URL throws before the request.

Use that `db` for every query of your app (`db.get`, `db.all`, `db.run`, `db.transaction`), with `?` placeholders.
Inside `db.transaction(async (tx) => ...)` and in the engine hooks, query only through `tx`, and make no network
calls. The wrapper enforces both: a `db` query inside a transaction throws (it would not be part of it), and on
SQLite the raw handle throws while a transaction is open (it would silently join it). Several app processes can
run the engines on one database: each state change re-checks its row inside a transaction, so two processes never
pay twice or credit twice.

What the engines decide for you:
- **Retries:** only `temporarily_unavailable` and `quote_expired` get a new attempt (new reference, new quote).
  Any other `failure_reason` fails the payment at once and calls `onFailed` (refund your user there).
- **Returned:** an offramp returned after success calls `onFailed` (GlobalStack credits the wallet back). A returned
  conversion stays completed and raises an alert (nothing is credited back). Transfers are never returned. An
  onramp returned after credit calls `onReturnedAfterCredit` if you give it, and raises an alert.
- **Alerts:** the engines raise an alert whenever a person must look: a return after success, a success after
  a payment was failed, our wallet short of funds. They are logged as `ALERT ...`; send them to your paging or chat
  tool with `onGlobalStackAlert((message) => ...)`.
- **Notifications:** each engine's `onSettled` hook runs after the change is committed. Tell your user there
  (email, push): never from inside `onCompleted`, `onFailed` or `onCredited`, which run inside a transaction.
- **Limits:** `checkRoute` checks the route is open and granted, and checks an `amount` you pass against the
  catalog limits, which are in the route's currency. The provider can still refuse at quote time, which happens
  after you answered 201; the payment then fails and `onFailed` refunds the user.

## Money out: pay someone and debit your user

```ts
// payouts.ts
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ensureBeneficiary, payeeReference } from './globalstack/beneficiaries';
import { checkRoute } from './globalstack/catalog';
import { gs, Refused } from './globalstack/gs';
import { fromUnits, parseAmount, toSignedUnits, toUnits } from './globalstack/money';
import { createPayments } from './globalstack/payments';
import type { Db } from './globalstack/types';

const balanceOf = async (q: Db, id: string) => toSignedUnits((await q.get('SELECT usdc_balance FROM users WHERE id = ?', id)).usdc_balance);
const setBalance = (q: Db, id: string, u: bigint) => q.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(u), id);

export const payouts = createPayments(db, {
  kind: 'offramp',                       // or 'conversion', or 'transfer' (no quote: return { wallet_id, beneficiary_id, amount })
  prepare: async (p) => {                // runs once per attempt: a fresh quote every time
    const q = await gs('POST', '/v1/offramps/quotes', {
      body: JSON.stringify({ wallet_id: process.env.GLOBALSTACK_WALLET_ID, beneficiary_id: p.data.beneficiary_id, source_amount: p.data.amount }),
      idempotencyKey: `quote-${randomUUID()}`, retry: true,
    });
    return { quote_id: q.id, metadata: { user_id: p.data.user_id } };
  },
  onFailed: async (p, _reason, tx) => {  // refund, once, in the engine's transaction
    await setBalance(tx, p.data.user_id, (await balanceOf(tx, p.data.user_id)) + toUnits(p.data.amount));
  },
  onSettled: async (p) => { /* after the commit: tell the user p.status (completed or failed) */ },
});

export async function startPayout(userId: string, rawAmount: unknown, payee: Record<string, unknown>) {
  const amount = parseAmount(rawAmount, 2);
  if (!amount) throw new Refused('amount must be a positive decimal with at most 2 decimals', 400);
  await checkRoute({ currency: 'GHS', country_code: 'GH', direction: 'offramp', network: 'bank' });
  // payee: { type: 'fiat', name, label, currency, country_code, network, provider_id, account_number, account_name }
  const body = { ...payee, customer_id: process.env.GLOBALSTACK_CUSTOMER_ID! };
  const beneficiaryId = await ensureBeneficiary({ ...body, merchant_reference: payeeReference(userId, body) });
  const id = `po_${randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {   // debit and payment record together, or not at all
    const b = await balanceOf(tx, userId);
    if (toUnits(amount) > b) throw new Refused('insufficient balance');
    await setBalance(tx, userId, b - toUnits(amount));
    await payouts.create(tx, id, { user_id: userId, amount, beneficiary_id: beneficiaryId });
  });
  void payouts.drive(id);                // runs in the background; answer 201 now
  return { id };
}
// Status for your API: (await payouts.get(id)).status is pending | completed | failed.
// No debit to make (you pay from your own wallet)? Still create inside a transaction:
//   await db.transaction((tx) => payouts.create(tx, id, data));
// Several corridors? One engine per kind: switch on p.data inside prepare().
```

## Money in: collect local money, credit USDC

```ts
import { createCollections } from './globalstack/collections';

export const topups = createCollections(db, {
  quoteBody: (c) => ({ wallet_id: process.env.GLOBALSTACK_WALLET_ID, source_currency: 'GHS', country_code: 'GH',
    source_network: 'mobile_money', source_amount: c.data.amount, phone_number: c.data.phone, provider_id: c.data.provider_id, full_name: c.data.full_name }),
  onCredited: async (c, amount, _onramp, tx) => { /* with tx: add `amount` (received_amount) to c.data.user_id's balance */ },
  onSettled: async (c) => { /* after the commit: tell the user c.status (completed, failed or returned) */ },
});

// In the route: checkRoute(...direction: 'onramp'...), then
const c = await topups.start(`tp_${randomUUID().replace(/-/g, '')}`, { user_id, amount, phone, provider_id, full_name });
// c.onramp.deposit_instruction holds what the payer must do (bank details, or the mobile money prompt).
// If c.onramp is null, GlobalStack has not confirmed it yet: answer 202 { id, status: 'pending' }. The poller
// carries on, and your GET route returns the instructions once (await topups.get(id)).onramp is set.
```

## Crypto deposits: give each user an address, credit what arrives

```ts
import { createDeposits } from './globalstack/deposits';

export const deposits = createDeposits(db, {
  walletId: process.env.GLOBALSTACK_WALLET_ID!, network: 'base',   // one engine per network
  userExists: async (id) => !!(await db.get('SELECT id FROM users WHERE id = ?', id)),
  onCredited: async (userId, amount, _txn, tx) => { /* with tx: add `amount` to the user's balance */ },
});
// Route: res.status(201).json(await deposits.addressFor(user_id));   // { address }, the same every time
// Webhook: await deposits.onEvent(event);   Startup: deposits.startPolling();
```

## Server and setup

```ts
// server.ts (Express). Register the webhook route BEFORE app.use(express.json()): it needs the raw bytes.
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, async (event) => {
  await payouts.onEvent(event);          // each engine ignores other categories
}));
app.use(express.json());
app.post('/payouts', async (req, res) => {
  try { res.status(201).json(await startPayout(req.body.user_id, req.body.amount, req.body.payee)); }
  catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'try again shortly; nothing was charged' });
    else res.status(500).json({ error: 'internal error' });
  }
});
app.listen(port, () => payouts.start()); // collections and deposits: startPolling(). Resumes after a crash, then polls.

// setup.ts (once per environment; safe to run again)
await ensureWebhook(db, `${process.env.PUBLIC_URL}/webhooks/globalstack`, ['offramp']); // skips an http:// URL, with a warning
await requestAccessIfNeeded('XAF', 'CM', 'why we need it');   // only for gated routes
```

Other frameworks use `webhookReceiver(db, onEvent)`, which takes the raw body and the headers and returns
`{ status, body }` to answer with:

```ts
const receive = webhookReceiver(db, onEvent);
// Next.js route handler, Hono, Bun, Deno (Fetch API):
export async function POST(req: Request) {
  const out = await receive(await req.text(), req.headers);
  return Response.json(out.body, { status: out.status });
}
// Fastify: give this route a string body parser, then  const out = await receive(req.body, req.headers); reply.code(out.status).send(out.body);
// NestJS: NestFactory.create(AppModule, { rawBody: true }), then pass req.rawBody and req.headers.
```
