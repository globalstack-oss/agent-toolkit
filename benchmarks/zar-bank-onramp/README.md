# zar-bank-onramp

ZAR bank funding to a business USDC balance. Flow: onramp with deposit instructions. Earlier id: T2.

South African businesses pay ZAR from their bank; the app gives them the bank details to pay and credits their USDC when the money arrives.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (9)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `route-closed` | The ZAR onramp route is closed when the business asks; the app must not credit anything, and must work once the route reopens. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks zar-bank-onramp
```
