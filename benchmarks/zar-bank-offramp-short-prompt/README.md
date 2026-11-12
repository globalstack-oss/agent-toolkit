# zar-bank-offramp-short-prompt

USDC balance to South African bank accounts, from a short request. Flow: offramp. Earlier id: T10.

The request is two casual lines ("can you add that?"); the agent must work out the flow itself.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (11)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks zar-bank-offramp-short-prompt
```
