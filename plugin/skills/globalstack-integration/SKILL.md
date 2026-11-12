---
name: globalstack-integration
license: MIT
description: >-
  Rules for building a correct GlobalStack integration: stablecoin onramps,
  offramps, conversions, crypto transfers, wallets, deposits, beneficiaries,
  customers and KYC, and webhooks on the GlobalStack API (api.globalstack.io/v1).
  Use when planning, writing, testing or reviewing any code that calls the
  GlobalStack API, or when the user mentions GlobalStack, Global Stack, gsa_sk_
  keys, USDC payouts to African bank or mobile money accounts, or
  docs.globalstack.io.
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/gs.mjs *)
---

# GlobalStack best practices

Base URL: `https://api.globalstack.io`. Full docs as one file: `https://docs.globalstack.io/llms-full.txt`.
Read the matching docs page before you write code for an endpoint. This file lists the rules that
integrations most often get wrong. Where this file and the docs disagree, follow this file.

## 0. How to build it

1. Ask the user: pay out or collect, which currency and country, bank or mobile money, who pays or receives
   (their own accounts, businesses, individuals), and where the app runs (a server that keeps running, or serverless).
2. For each flow, run `node <this skill's folder>/scripts/gs.mjs build_guidance '<json>'` (section 11). It checks
   the route on the live account and returns the flow's playbook. If `can_build` is false, tell the user its
   `next_step` before you write code.
3. Read `code/README.md`. Copy the files in `code/` into the app unchanged and build each flow on them (in another
   language, port them one for one). Every execute call goes through `createPayments` or `createCollections`.
4. Test the app in the failure sandbox (the `globalstack-testing` skill): every fault that applies to the flow,
   until its report has no warnings.
5. Run `gs.mjs build_check_acceptance '{"flow":"<flow>"}'` and check each item in the code. Fix what fails.
6. Tell the developer what is left: access requests, the webhook URL, and the smallest live test from the
   playbook. The developer runs it; never make a write call with a real key yourself.

`checklist.md`, `playbooks.md` and `reference.md` in this folder hold the code checklist, the playbooks, and
lookup details (formats, fields, tables). The scripts return the parts a flow needs.

## 1. Safety first: there is no test environment

- Every call with a secret key runs against live money. GlobalStack has no sandbox or test mode:
  `sandbox.globalstack.io` is production, and `gsa_sk_test_` keys are rejected with `401`. To test without
  money, use the local failure sandbox in the `globalstack-testing` skill: a copy of the API that runs on
  this machine and fails on purpose.
- Only `GET` calls are read-only.
- Creating a quote is NOT read-only. It opens a live conversion with a payment provider, can create a
  deposit address, and for a ZAR offramp registers the payout bank account with the provider. Only
  create a quote when you intend to execute it.
- Your first money movement must be the smallest amount the corridor allows.
- Never run a write call in a loop, a retry storm, or a test suite without a human asking for it.
- Keep the secret key server-side. Never put it in client code or commit it.

## 2. Check coverage before you build a flow

Do not assume a country, currency or direction works. Ask the API first:

1. `GET /v1/countries?currency=NGN&network=bank` shows where a currency and network are available.
2. `GET /v1/currencies?type=fiat&can_offramp=true` shows capability flags and limits per network, one row per
   `code` and `country_code` (`XAF` and `XOF` have a row per country).
3. Add `customer_id=cust_...` for what this customer can do now. Today the only restriction is `deposit`
   (`customer_kyc_not_approved`).
4. A row with `requires_access = true` needs `POST /v1/currencies/{code}/access-requests` first (with
   `country_code` in the body for `XAF` and `XOF`). Until it is approved, calls fail with
   `403 resource_access_required`: tell the user access is pending. `requires_access` never changes; in code,
   check your own grant with `has_access` on the currency row (`reference.md`, Currency access).

Run these checks in the request path, when a user starts a flow, not only in a setup script.

If a flag is `false` at platform level, the flow is not available. Stop and tell the user. Do not
retry, and do not switch providers or networks to work around it.

## 3. Direction names

- Onramp (`POST /v1/onramps`): local fiat in, USDC to a GlobalStack wallet. For mobile money, executing it
  starts the collection from the payer's phone; for a bank, the response carries deposit instructions.
- Offramp (`POST /v1/offramps`): USDC out of a wallet, local fiat paid to a beneficiary.
- Conversion (`POST /v1/conversions`): one wallet's balance into another wallet's currency.
- Transfer (`POST /v1/transfers`): crypto from a wallet to an external crypto address.

## 4. Every money movement is quote, then execute

1. Create a quote: `POST /v1/onramps/quotes`, `/v1/offramps/quotes` or `/v1/conversions/quotes`.
2. Execute it with the `quote_id`: `POST /v1/onramps`, `/v1/offramps` or `/v1/conversions`.

Rules:
- A quote's life depends on the provider, from about 16 to 60 minutes. Always read `expires_at`.
  An expired quote returns `409 invalid_status`. Create a new quote.
- A quote creates at most one movement. Once an execute call has created one, any execute with the same
  `quote_id` returns `409 duplicate_resource`. An error raised before that (expired quote, wrong currency,
  a `reference` that is too long or already used) does not use up the quote, and the same request returns
  the same error: after a `4xx`, never resend that `quote_id`. Look the movement up, then get a new quote.
- Never let your HTTP client retry an execute call on its own. A resend is always the saved request (same
  `Idempotency-Key`, exact same body bytes), so it replays the first answer or gets `409 duplicate_resource`.
  After a timeout, a `5xx` or a `409`, the outcome is unknown: list the movements
  (`GET /v1/offramps?created_after=YYYY-MM-DD`, same for onramps and conversions) and page through for your
  `reference` or the `quote_id`. There is no filter for either, and the quote can still read `active` after an
  execute created a movement. Start again with a new quote and the next attempt number only once you are sure
  nothing was created, or it failed. `createPayments` and `createCollections` (section 11) do all of this.
- Read a movement's status from its own resource (`GET /v1/offramps/{id}`), not from
  `GET /v1/transactions`, which can lag behind.
- Send exactly one of `source_amount` or `target_amount`. Both or neither returns `400`.
- Use the quote for the real price. `GET /v1/currencies/{code}/rates` is a guide only.
- If you pass `source_currency` or `destination_currency` on execute, they must match the quote.
- The customer's profile must be complete before a quote: phone, date of birth, ID number and ID type,
  and address (for a business, its registration number). A missing field returns `400` at quote time.
- A short wallet balance at execute returns `422 ledger_insufficient_funds`, and the offramp is stored as
  `failed` (`insufficient_funds`). A transfer is worse: it stays `processing` forever with no webhook, and its
  reference is used up. Check the balance first; treat the 422 as final and use a new reference.
- Show the payer all of an onramp's `deposit_instruction` (`reference.md`): a `depositReference` must be
  quoted, and payment is due before `expiresAt`. A later bank payment is decided by the provider and can fail:
  keep the onramp open until its final status, and never credit or fail it on `expiresAt` yourself.

## 5. Amounts

- Send amounts as decimal strings, never as floats: `"100.50"`, not `100.5`.
- Round every USDC amount DOWN to 2 decimals before you send it. Some wallets reject finer amounts
  with `400 invalid_amount_precision`. This matters when you take a 6-decimal on-chain balance.
- The min and max in `GET /v1/currencies` (`networks[].inbound` for money in, `networks[].outbound` for money
  out) are in the row's own currency, never USDC, and only a guide: the provider's limits apply at quote time,
  so a quote can still refuse an amount the catalog allows.
- Fees are in the quote's `fee.line_items` (missing when there are none). The quote's `received_amount` is
  the provider's estimate of what it delivers after fees.
- Credit and record what the final movement says, never the quote: an onramp's or conversion's
  `received_amount` is null until it succeeds, then holds the delivered amount. Use `target_amount` on the
  quote when the recipient must get an exact amount.
- A transfer debits exactly `amount` from the wallet. Its response has no fee or received amount.

## 6. Beneficiaries (payout details)

Create a fiat beneficiary with `POST /v1/beneficiaries`:
- Every body needs `type` (`fiat`), `name` (the payee), `label` (yours, e.g. `payout`) and `currency`.
- Always pass `customer_id`. Without it, the beneficiary belongs to your default customer, and an
  offramp from a customer's wallet fails with `404 not_found`. Beneficiary and wallet must belong to
  the same customer.
- `provider_id` is required. Get it from `GET /v1/countries/{country_code}/providers?network=bank&active=true`.
  Match on the provider's name or code in that list. Never send a bank code or bank name as `provider_id`.
  The one exception is the ZAR PayShap rail (`reference.md`).
- `network` is `bank` or `mobile_money`. For `mobile_money`, `account_number` holds the phone number.
- `account_name` is required everywhere except NGN and GHS bank accounts. For those, GlobalStack takes
  the name from the bank, ignores what you send, and does not let you change it later. Read the
  bank's name back from `details.account_name` on the beneficiary and show it to the user.
- Some accounts are checked with the provider at creation, the rest only at quote, and ZAR account numbers
  have a format check (`reference.md`). `account_resolution_failed`, or a `400 invalid_input` carrying the
  provider's message, means the details are wrong: ask the user to check them, never retry the same values.
- Never pad, cut or otherwise change an account number. Remove spaces and dashes the user typed only after
  showing them the number you will send.
- Send the account holder's name as they spell it, without leading, trailing or double spaces. Do not reject
  a one-word name: the API has no first-and-last-name rule, but a bank can fail the payout on the name, so ask
  for the full name as on the account, and send the minimum first to a new one-word-name account.
- Beneficiary creation ignores `Idempotency-Key`. Its only duplicate guard is `merchant_reference`, unique per
  integration: a second create with it returns `409 duplicate_resource`; look the beneficiary up and reuse it.
  Build the reference from the payout details, not from your user id alone (`payeeReference(owner, body)` in
  `code/beneficiaries.ts`): a retry finds the same beneficiary, and corrected details get a new one instead of
  paying the old account. Keep the id (`ensureBeneficiary(body, db)` does).

## 7. Customers, KYC and limits

- Wallets belong to a customer. Create the customer first: `POST /v1/customers`. An individual customer needs
  a first and a last name (some payout providers require it). Beneficiary names have no such rule.
- A customer without approved KYC cannot get a fiat wallet or fiat deposit details. Start KYC with
  `POST /v1/customers/{customerId}/verifications`, send the customer to its `hosted_url` (it expires), and wait
  for `kyc.approved` or `kyc.rejected` (`reference.md`, KYC). In those events the customer is
  `event_object.customer.id`; `event_object_id` is the verification session.
- Money-in is capped at USD 1,000,000 per rolling 30 days for `tier_1` and `tier_2` customers; a `tier_0`
  customer's counts against your own merchant limit. A deposit over the limit arrives as `deposit.held`
  (`metadata.hold_reason`: `tier_limit`, `payin_frozen` or `payin_disabled`): tell the user it is held, not
  lost or failed.
- A crypto deposit address is `details.address` (there is no top-level `address`). Each deposit to it is a
  transaction (`type: deposit`); credit it only at `status: success`.

## 8. Idempotency and references

- Send an `Idempotency-Key` header on every money `POST`, matching `^[A-Za-z0-9_-]{8,255}$`. It must stay the same
  on every resend: derive it from your saved record (the engines use the movement's `reference`), or save a UUID
  with the record before the first call. A key made fresh on each call protects nothing.
- A retry must send the same key and the exact same body bytes. Serialize the body once, store it,
  and resend that string. Reordered JSON keys return `409 idempotency_conflict`.
- `409 idempotency_in_progress` means the first request is still running. Wait, then retry.
- Only successful responses are stored. After an error, a retry with the same key runs again.
- `reference` (max 128 characters) is required on offramp, conversion and transfer execute, and is unique in
  your integration, failed movements included. Build it from your record id plus an attempt number (`wd_123-1`)
  and save it before the call: a retry after a crash or timeout reuses it and gets `409 duplicate_resource`, not
  a second payment. Move to the next attempt number only once the previous attempt has failed; never use a
  random reference. As it is also the key, record ids use only letters, digits, `_` and `-`. The offramp quote
  takes `narration`, not `reference`.

## 9. Errors and failures

Two different things:
- A request error: the call returns `status: false` and a `code`. Branch on `code`, never on
  `message`. Log `meta.request_id`.
- A failed money movement: the call succeeded, and the resource later reaches `failed`. Branch on
  `failure_reason`, never on `failure_reason_message`.

Retry with backoff: `429 rate_limited`, `502 ledger_unavailable`, `503 ledger_lock_contention`.
After a `500 external_service_unavailable` on an execute, look the movement up by reference first.

`failure_reason` is null unless the movement is final and not `success`. Start a failed movement again, with
a new quote and the next attempt number, only after `temporarily_unavailable`, or `quote_expired` on money out
(for money in, the payer starts again). Every other reason needs a person: `reference.md` says what each means.

`returned` can follow `success`, for onramps, offramps and conversions; there is no fixed delay.
- Offramp returned after its USDC left your wallet: GlobalStack credits the full source amount back to
  the wallet (a deposit with `source_type: offramp_reversal`). Undo the payout in your books.
- Conversion returned after it settled: there is no automatic credit. Contact GlobalStack support.
- Onramp returned after you credited the user: GlobalStack moves no money. Flag it for a human; you may
  need to take the USDC back from the user.

## 10. Webhooks

- Subscribe by category: `onramp`, `offramp`, `conversion`, `transfer`, `deposit`, `kyc`.
- The URL must be `https` on a public host name: `http://` and `https://localhost` are refused (`400`).
  `ensureWebhook` skips such a URL (local, some staging) with a warning; the pollers still finish every payment.
- A new endpoint is **inactive**. Save the `signing_secret` from the create response (shown once),
  then `PATCH /v1/notifications/webhooks/{id}` with `{ "active": true }`.
- Verify every delivery with a Svix library against the **raw** body, then parse that raw body yourself
  (svix 2.x's `verify` returns nothing). `webhookReceiver` in `code/webhooks.ts` does this in any framework.
- Deduplicate on `event_id`: a retry repeats it. Mark an event done only after your processing committed, so an
  event whose processing failed runs again on redelivery.
- Final states: onramp, offramp and conversion `success`, `failed` and `returned` (which can follow
  `success`); transfer `success` and `failed`; deposit `confirmed` and `failed`; KYC `approved` and `rejected`.
  `funds_received` and `processing` are never final.
- Reconcile on `received_amount`, what actually reached the recipient, not `destination_amount`, the quoted
  figure, which can be before a fee. `received_amount` is `null` until success: treat `null` as "not known
  yet", never as zero.
- A cross-currency deposit stays at `deposit.received` or `deposit.held`. The `conversion.*` events
  carry the outcome. Its `destination_amount` can be `null` (not converted yet, never zero): a deposit under the
  corridor minimum waits and converts with later ones. Reconcile on `conversion.*`, never on a sum of deposits.
- Also poll `GET` for the resource if no final event arrives, so a missed webhook never leaves a
  payment unknown.
- Never mark a money movement failed on your own timeout. GlobalStack's final state wins. If a
  `success` arrives for something you already marked failed or returned, flag it for a human. Do not
  ignore it, and do not silently relabel it.

## 11. The plugin scripts and the reference code

Paths are relative to this skill's folder. Run the scripts from the app's folder, with the full path to the
script. They need Node 20 or later, whatever language the app is in; if `node --version` fails, ask the developer
to install Node, and do not work around the scripts. They read the key from `GLOBALSTACK_API_KEY`: never pass it
as an argument or write it to a file or the chat. A Viewer key is enough; if the account check reports `api_key`
as `warn`, tell the developer once and carry on. If a result starts with `plugin_update`, tell the developer once,
with its `how_to_update`, and carry on.

- `scripts/gs.mjs` only sends `GET` requests: it never creates, changes or pays anything. `--list` lists every check.
  - `build_guidance '<json>'`: a `flow` (`ngn_bank_withdraw`, `xaf_momo_topup`, `zar_bank_funding`,
    `kes_mpesa_payout`), or `direction`, `currency` and `country_code` for any other corridor.
  - `build_check_acceptance '{"flow":"<flow>"}'` (`"general"` with the corridor when it has no playbook): the
    account checks, the sandbox faults this folder passed, the app's copies of `code/` that differ from this
    plugin's (each is a fix to copy in), and the code checklist. Mark each item pass or fail from the code, and
    show the user what is missing.
  - `search_docs '{"query":"..."}'` finds request bodies, fields and response shapes in the public docs (offline,
    in the copy in `docs/`); `'{"page":"/errors"}'` returns a whole page. Look fields up there, not in the
    scripts' source: the sandbox imitates the API for tests, the docs define it.
- `code/` is the reference code: `createPayments` for money out (offramp, conversion, transfer), `createCollections`
  for money in (onramp), `createDeposits` for crypto deposit addresses, `ensureBeneficiary` and `payeeReference`,
  `checkRoute`, `ensureWebhook` and `webhookReceiver`. It follows sections 4 to 10 and was tested against lost
  responses, provider errors, crashes, rate limits, returns and bad webhooks. Do not rewrite its retry, lookup or
  webhook logic. Its pollers need a process that keeps running; on serverless, `code/README.md` says what to do.
- In another language, port the files you need one for one, in the app's own framework and database layer: the
  same states, the same checks in the same database transactions, the same retry and lookup paths, the same poller.
  Keep the User-Agent, with the app's language in place of `node`: `globalstack-reference-python/2`. A port is
  done only when it passes every fault of the failure sandbox that applies to the flow.

## 12. When you are stuck

Quote the `request_id` and the resource id (`ofr_...`, `con_...`, `tfr_...`) to GlobalStack
support. Never guess at a fix that moves money.
