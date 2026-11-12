# xaf-mobile-money-offramp-postgres

USDC balance to XAF mobile money, on Postgres. Flow: offramp, Postgres. Earlier id: T11.

Users in Cameroon cash out USDC to MTN Mobile Money or Orange Money in XAF. The app uses Postgres instead of SQLite, and XAF payouts are not enabled for the account yet.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/postgres`](../starters/postgres) (Postgres). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (12)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `access-pending-payout` | XAF payouts are not enabled yet (access pending). Nothing may be paid until access is granted; after approval the payout goes through. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks xaf-mobile-money-offramp-postgres
```
