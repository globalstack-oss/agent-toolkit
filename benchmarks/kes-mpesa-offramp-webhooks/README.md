# kes-mpesa-offramp-webhooks

KES payouts to M-Pesa, with payout records. Flow: offramp, amount fixed in the target currency. Earlier id: T4.

The merchant pays Kenyan freelancers a fixed KES amount to M-Pesa from its USDC wallet and keeps payout records (pending, paid, failed) in sync from webhooks.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (11)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks kes-mpesa-offramp-webhooks
```
