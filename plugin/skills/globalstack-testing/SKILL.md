---
name: globalstack-testing
license: MIT
description: >-
  Test GlobalStack integration code against a local copy of the GlobalStack API that fails on purpose (lost
  response, provider error, rate limit, missing or forged webhooks, slow final state) before any real money moves.
  Use after writing or changing code that calls the GlobalStack API, and before the smallest live test.
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/sandbox.mjs *)
---

# GlobalStack failure sandbox

There is no GlobalStack test mode: every call with a real key moves real money. This sandbox is a local copy of
the `/v1` API that runs on this machine. It never calls the real API and needs no key. Each start resets all data.
It works with an app in any language. The script path below is relative to this skill's folder (the folder this
`SKILL.md` is in). Run it from the app's folder, with the full path to the script: it keeps its files in
`.globalstack-sandbox/` there, a folder that git ignores. It needs Node 20 or later.

## Run it

1. Start it with the port your app listens on and one fault:
   `node scripts/sandbox.mjs start --app-port 3000 --fault lost_response`
   It returns `base_url` and `secret_key` (see `env`), the customer and wallet ids to use, test payout accounts,
   and the public origin to register webhooks under. Webhooks sent there are delivered to your app's port.
2. Point the app at `base_url` with `secret_key`, start it (run its setup again: the sandbox starts empty), and
   drive the flow end to end through the app's own endpoint, as a user would.
3. Run `node scripts/sandbox.mjs report`. Fix every item in `warnings`: double payments, a refused quote sent
   again, a forged webhook accepted, a final state your app never read, a flow with no active webhook endpoint.
   Follow `hints` when the run is waiting for something (a payer, the clock, a fault that has not happened yet).
4. Then check each `check_in_app` item in your app's own database. The sandbox only sees API calls and webhook
   answers: a report with no warnings does not prove your books are right.
5. Start again with the same fault until the report has no warnings, then move to the next fault. Run
   `node scripts/sandbox.mjs stop` when done. A sandbox nobody uses for 4 hours stops on its own.

`faults_tested` in the report, and the sandbox item of `gs.mjs build_check_acceptance`, list each fault as
`no_warnings`, `warnings`, `fault_not_triggered` (a payment ran, but the fault never happened: drive the flow
further), `no_payment` (started, but no money moved) or `not_run`.

## Faults

| Fault | What happens | Correct code |
| - | - | - |
| `none` | Everything succeeds; webhooks arrive once, in order. | Finishes the flow from the final webhook, once. |
| `lost_response` | The next execute succeeds but its response is dropped. | Finds the movement by its reference. Does not pay twice. |
| `provider_error` | The next execute answers 500 and the payout is failed. Not for bank onramps. | Looks it up by reference, then retries on its own with the next attempt number and a new quote. |
| `rate_limit` | The next 2 money writes answer 429 (not onramps). | Backs off and resends the same body with the same Idempotency-Key. |
| `webhook_silence` | No webhook is delivered. | Polls movements that are not final. |
| `webhook_noise` | Duplicates, a stale event after the final one, one forged event. | Verifies signatures (forged answered 4xx), dedupes on event_id, never moves a final state back. |
| `slow_final` | Movements stay processing until the clock moves 3 hours. | Keeps the payment pending. Never fails it on its own timeout. |

## Controls

Each acts as a payer, a provider or GlobalStack would. Run them as `node scripts/sandbox.mjs <command>` while the
sandbox is running:

- `pay [onr_...]`: the payer sends the bank transfer for a bank onramp. A bank onramp waits in
  `awaiting_deposit` until you run it (every unpaid one when no id is given).
- `advance --hours <n>`: moves the sandbox clock (quote expiries, webhook retries, `slow_final`). Your app's clock
  stays on real time unless you started with `--app-clock`: then start your app with the variables printed under
  `app_clock` (Node: a `--import` preload; Python: `PYTHONPATH`, with the `time-machine` package installed), and
  its `Date`, timers and sleeps move with the sandbox. Use it to test that your app never fails a payment on its
  own timer.
- `return <id>`: a successful onramp, offramp or conversion is returned. Test that your app undoes a returned
  payout once, and flags a returned conversion or onramp for a human.
- `kyc approve|reject|start <cust_...> [--retry]`: the KYC provider's verdict on a customer whose verification your
  app started. `--retry` asks the customer to resubmit.
- `deposit <address, da_... or wcr_...> <amount>`: an on-chain USDC deposit arrives at an address your app created.
- `approve-access <currency> [--country CM]`: GlobalStack approves your access request. Start with
  `--xaf-access pending` to test a Cameroon (XAF) flow before and after approval.

## What this sandbox does not test

- Your app's own database: a double credit, a refund after a success, a state moved back. Check `check_in_app`.
- A crash between saving a payment and getting the execute's answer. Test it by hand: stop the app (kill it)
  right after it saves the payment, start it again, and check the payment finishes once, by reference.
- Two faults at once. Each start has one fault.
- A route closing during a run. To test a closed route, copy `catalog.json` from this skill's folder, set
  `can_offramp` (or `can_onramp`) to `false` on the row, and start with `GLOBALSTACK_CATALOG` set to the copy.
- Real providers: prices come from fixed rates, and provider messages and timings are approximations.
- Routes it does not simulate answer `501 not_in_sandbox` (editing or deleting a beneficiary, a customer or a
  wallet; webhook secret rotation, test sends, events and logs). The report lists them under `hints`.

Pass every fault that applies to the flow before the smallest live test. The reports are the evidence: show the
developer the warnings you fixed, the `check_in_app` items you checked, and the `faults_tested` list.
