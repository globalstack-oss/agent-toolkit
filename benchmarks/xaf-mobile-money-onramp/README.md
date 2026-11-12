# xaf-mobile-money-onramp

XAF mobile money top-ups to a USDC balance. Flow: onramp. Earlier id: T1.

Users in Cameroon pay XAF with MTN MoMo or Orange Money; the app shows payment instructions and credits their USDC balance once the money arrives.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (10)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `access-pending` | XAF collections are not enabled yet (access pending). No collection may start before access is granted; after approval the top-up goes through. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks xaf-mobile-money-onramp
```
