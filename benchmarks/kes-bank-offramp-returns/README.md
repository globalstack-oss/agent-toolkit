# kes-bank-offramp-returns

USDC balance to Kenyan bank accounts, with returns. Flow: offramp, returned payments. Earlier id: T9.

Users withdraw USDC and receive KES in their bank. Kenyan bank payments can bounce back days after they succeeded; then the user must get their USDC back.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (13)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `returned-after-success` | The bank returns the payment after it succeeded; the user gets their USDC back once. |
| `returned-noisy` | The same return, with every webhook delivered twice; refund exactly once. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks kes-bank-offramp-returns
```
