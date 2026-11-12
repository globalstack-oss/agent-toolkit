# kes-bank-offramp-seller-kyc

Seller onboarding with KYC, then KES bank payouts. Flow: customers, KYC, offramp. Earlier id: T8.

A Kenyan marketplace creates each seller as a Global Stack customer, starts their identity verification, and pays them in KES to their bank only once verification is approved.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (15)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

Scenarios for this job:

| Scenario | What happens |
| - | - |
| `kyc-approved` | The seller is onboarded, verification is approved, the payout goes out. |
| `kyc-pending` | Payouts asked while verification is in progress, and after a resubmission request, are refused; once approved, the next payout goes out. |
| `kyc-rejected` | The seller's verification is rejected; no payout may go out. |
| `onboarding-lost-response` | The answer to creating the seller's customer is lost, and the seller taps "verify" twice; no duplicate customer. |

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks kes-bank-offramp-seller-kyc
```
