# ngn-bank-offramp

USDC balance to Nigerian bank accounts. Flow: offramp. Earlier id: T3.

Users withdraw an amount of USDC, or everything, and receive NGN in their bank account.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (14)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `wrong-account` | The user's bank account does not resolve; the payout fails and the user's USDC must come back. |
| `withdraw-all` | The user asks to withdraw everything; the app must pay out exactly the balance, fees included. |
| `double-spend` | Two "withdraw everything" requests arrive at the same moment; only one may be paid. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks ngn-bank-offramp
```
