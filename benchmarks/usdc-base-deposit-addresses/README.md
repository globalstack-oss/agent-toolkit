# usdc-base-deposit-addresses

USDC deposits on Base, one address per user. Flow: deposit addresses. Earlier id: T7.

Each user gets their own USDC deposit address on Base; the app credits their balance when a deposit is confirmed.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (13)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `two-users` | Two users deposit; the same user asks again and must get the same address, and a second deposit is credited. |
| `deposit-slow-confirm` | The deposit is received now and confirmed on chain three hours later; credit once, on confirmation. |
| `deposit-held` | The deposit is over the money-in cap: Global Stack holds it, then ops release it. |
| `deposit-voided` | The deposit is received, then voided by ops; nothing may be credited. |
| `deposit-crash` | The app is down when the deposit is confirmed; webhook retries and polling must still credit it once. |
| `deposit-duplicate-events` | Every event twice, then all again in reverse order, then a forged confirmation for 10x the amount. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks usdc-base-deposit-addresses
```
