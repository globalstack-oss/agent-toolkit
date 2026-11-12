# Code checklist

Every money flow's code must pass each item. `scripts/gs.mjs build_check_acceptance` returns this list for the agent
to check in the merchant's code. The number in brackets is the `SKILL.md` section the rule comes from.

- [11] Build on the reference code in this skill's `code/` folder, copied unchanged (in another language, ported one for one).
  Do not edit those files, even to make them stricter: "never resend" edits left collections stuck after a provider error.
  Check: the app has its files unchanged, or a port with the same states and retry paths, and every execute goes through createPayments or createCollections.
- [8] Send an `Idempotency-Key` header on every money `POST`, the same on every resend: derived from your saved record, or a UUID saved with it.
  Check: find each POST to `/v1/onramps`, `/v1/offramps`, `/v1/conversions`, `/v1/transfers`; no key is made fresh per call.
- [8] A retry sends the same key and the exact same body bytes.
  Check: the body is serialized once and stored before the first call.
- [8] Build `reference` from your own record id plus an attempt number, saved before the call.
  Check: no random reference; the attempt number changes only after the previous attempt is confirmed failed.
- [2] Check the route when a user starts a flow: the capability flag, and for a `requires_access` row your own grant.
  Check: the request path calls `GET /v1/currencies`, reads `has_access` on a `requires_access` row, and stops with a clear message, not a retry.
- [4] Never let the HTTP client retry an execute call on its own. A resend is the saved request, and after a timeout, 5xx or 409 the movement is looked up by reference.
  Check: no retry library or wrapper on execute calls; resends reuse the stored body and key; a lookup runs on an unknown outcome.
- [4] After an execute error, retry automatically: look the movement up by reference; if it failed or does not exist, get a new quote and execute with the next attempt number. Up to 3 attempts, then mark it failed and refund.
  Check: no code path, reconciler or resume job sends execute twice with the same `quote_id` after a 4xx.
- [9] Retry `429`, `502` and `503` with backoff. Never retry a `400`, a `422` or a `failed` movement.
  Check: one retry helper for GET and quote calls, with backoff, keyed on `code`.
- [6] An offramp beneficiary gets `customer_id`, a `provider_id` looked up from the providers list, and a `merchant_reference` built from the payout details.
  Check: no bank code, bank name or env var used as `provider_id`; `merchant_reference` comes from `payeeReference`, not from the user id alone.
- [5] Send amounts as decimal strings. Round USDC down to 2 decimals.
  Check: no float amounts, and no `Math.round` on USDC.
- [4] Read status from the payment resource, not from `/v1/transactions`.
  Check: status reads use `GET /v1/offramps/{id}` or `GET /v1/onramps/{id}`.
- [9] Branch on `code` and `failure_reason`, never on `message`.
  Check: no string matching on error messages.
- [10] Verify each webhook with Svix on the raw body, dedupe on `event_id`, and mark an event done only once it was processed.
  Check: the receiver reads the raw body before JSON parsing, and an event whose processing failed is processed again on redelivery.
- [10] Reconcile on `received_amount`. Treat `null` as not known yet, never as zero.
  Check: no payout is marked paid from `destination_amount`.
- [10] Never mark a payment failed on your own timeout. Poll the resource if no final event arrives.
  Check: a poll job runs for payments with no final state: the engines' `start()`, or their `reconcile()` from a scheduled job on serverless.
