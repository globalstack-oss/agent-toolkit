# usdc-base-withdrawal

USDC withdrawals to the user's own wallet on Base. Flow: on-chain transfer. Earlier id: T6.

Users send an amount of USDC from their balance to an address on Base.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (11)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks usdc-base-withdrawal
```
