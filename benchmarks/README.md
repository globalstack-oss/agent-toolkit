# Global Stack integration benchmarks

Agentic evals based on real Global Stack integration jobs. Each folder is one job: a merchant asks a coding agent to
build a money flow into a small existing app. A grader then runs the app against the plugin's simulator, injects
failures (lost responses, crashes, duplicate or missing webhooks, provider errors, rate limits) and compares the app's
books with Global Stack's ledger.

Each build gets one of three outcomes:

| Outcome | Meaning |
| - | - |
| pass | Every scenario ends with the app's books equal to the ledger, and the money movement finished. |
| incomplete | The books are right, but a movement that should have finished did not. |
| unsafe | The books and the ledger disagree: money paid twice, credited twice, lost, or paid against a rule. |

The release bar is every build passing and 0 unsafe.

## Jobs

| Job | Money flow | What makes it hard |
| - | - | - |
| [`ngn-bank-offramp`](ngn-bank-offramp) | USDC balance to an NGN bank account | Withdraw-all, wrong account details, double spend |
| [`kes-bank-offramp-returns`](kes-bank-offramp-returns) | USDC balance to a KES bank account | The bank returns the payment days after it succeeded: refund the user once |
| [`kes-bank-offramp-seller-kyc`](kes-bank-offramp-seller-kyc) | Seller onboarding, then KES bank payouts | No payout before the seller's KYC is approved; pending and rejected KYC |
| [`kes-mpesa-offramp-webhooks`](kes-mpesa-offramp-webhooks) | KES to M-Pesa, amount fixed in KES | Payout records kept in sync from webhooks |
| [`zar-bank-offramp-short-prompt`](zar-bank-offramp-short-prompt) | USDC balance to a ZAR bank account | A two-line, casual request: the agent must work out the rest |
| [`xaf-mobile-money-offramp-postgres`](xaf-mobile-money-offramp-postgres) | USDC balance to MTN or Orange Money in XAF, on Postgres | XAF access is still pending: nothing may be paid |
| [`xaf-mobile-money-onramp`](xaf-mobile-money-onramp) | XAF mobile money to a USDC balance | Payment instructions, credit once when the money arrives, access pending |
| [`zar-bank-onramp`](zar-bank-onramp) | ZAR bank transfer to a business's USDC balance | Bank details lost in a crash; the route closes |
| [`usdc-to-ngn-wallet-conversion`](usdc-to-ngn-wallet-conversion) | USDC wallet to the merchant's NGN wallet | Exactly the requested NGN must arrive |
| [`usdc-base-withdrawal`](usdc-base-withdrawal) | USDC balance to the user's own wallet on Base | On-chain transfer with retries |
| [`usdc-base-deposit-addresses`](usdc-base-deposit-addresses) | One USDC deposit address per user on Base | Slow confirmation, held and voided deposits, forged events |

The jobs were first numbered T1 to T11; earlier results use those ids, and the harness still accepts them
(T1 `xaf-mobile-money-onramp`, T2 `zar-bank-onramp`, T3 `ngn-bank-offramp`, T4 `kes-mpesa-offramp-webhooks`,
T5 `usdc-to-ngn-wallet-conversion`, T6 `usdc-base-withdrawal`, T7 `usdc-base-deposit-addresses`,
T8 `kes-bank-offramp-seller-kyc`, T9 `kes-bank-offramp-returns`, T10 `zar-bank-offramp-short-prompt`,
T11 `xaf-mobile-money-offramp-postgres`).

## What is in a job folder

| File | What it is | Shown to the agent |
| - | - | - |
| `README.md` | The job in short and the scenarios it is graded on | No |
| `task.md` | The merchant's request and the HTTP interface the grader calls | Yes, as the prompt (after [`prompt/common.md`](prompt/common.md)) |
| `schema.sql` | The app's existing tables, with production data | Yes |
| `STARTER` | Optional: the starter app to use from [`starters/`](starters) (`postgres`); default `sqlite` | Yes, as the app it starts from |
| `reference/` | A reference app that passes every scenario, built on the plugin's reference code | No |

The grader is not in the job folder, so a build cannot see it: the per-job checks are in
[`harness/tasks.ts`](harness/tasks.ts) and the scenarios in [`harness/grade.ts`](harness/grade.ts).
The simulator is the plugin's own, [`src/sandbox`](../src/sandbox).

## What the jobs share

Everything that is not a job folder is shared by every job.

| Folder | What it is |
| - | - |
| [`harness/`](harness) | Builds a job with a coding agent (`build.ts`), grades a build on every scenario (`grade.ts`, per-job checks in `tasks.ts`), reports (`report.ts`), all three in one go (`run.ts`), and the no-agent check of the reference apps (`check-references.ts`). |
| [`prompt/`](prompt) | The part of the prompt every job shares (`common.md`, `common-py.md` for Python apps). |
| [`starters/`](starters) | The app a build starts from: `sqlite` (Express on SQLite), `postgres` (Express on Postgres) and `python` (FastAPI). |
| [`snapshot/`](snapshot) | Records the catalog of a live account for the simulator, and checks it against the account. |
| [`results/`](results) | Per build results of earlier runs. |

## Scenarios

Every job is graded on the scenarios below that apply to it, plus its own (listed in its README).

| Scenario | What happens |
| - | - |
| `happy-path` | Nothing goes wrong. |
| `lost-response` | Global Stack executes the movement but the app never gets the answer. |
| `crash` | The app is killed mid-movement and restarted. |
| `provider-error` | The payment provider fails the first execute. |
| `rate-limit` | Global Stack answers 429 for a while. |
| `webhook-noise` | Webhooks arrive twice, late, out of order, and some are forged. |
| `webhook-silence` | No webhook ever arrives: the app must poll. |
| `slow-truth` | The final status arrives much later than usual. |
| `combo-crash-silence` | A crash mid-payment and no webhooks. |
| `combo-lost-noisy` | A lost execute answer and noisy webhooks. |
| `combo-provider-ratelimit` | A provider failure, then rate limits on the retries. |

## Results

| Date | Agent | Prompt | Builds | Pass | Unsafe | Cost |
| - | - | - | - | - | - | - |
| 20 Oct 2026 | Claude Code, plugin 0.2.1 | Names the job, not the plugin; 8 TypeScript + 4 Python builds | 12 | 12 | 0 | $26.16 |
| 19 Oct 2026 | Claude Code, plugin 0.1.0 | Same 12 builds | 12 | 12 | 0 | $23.16 |
| 15 Oct 2026 | Claude Code, plugin | Names the plugin; every job, 5 builds each | 55 | 55 | 0 | median $1.71 a build |

On 15 Oct the first grade ran four builds at a time and 12 builds failed on port and CPU collisions; graded again one at
a time, all 12 passed. Per build results for the 19 and 20 Oct runs: [`results/2026-10-20-neutral-prompt.csv`](results/2026-10-20-neutral-prompt.csv).

Every job here has now been used while the plugin's rules were written, so these are regression results. A new
honest score needs new jobs the rules were not tuned on; those stay outside this repository until they have run.

## Run it

The fast check, no agent: copy the plugin's current reference code into every job's reference app and grade it on
every scenario (CI runs this on every pull request, about 10 to 15 minutes).

```bash
(cd benchmarks/starters/sqlite && npm ci) && (cd benchmarks/starters/postgres && npm ci)
export EVAL_PG_BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)   # Postgres jobs start their own cluster
node --experimental-strip-types benchmarks/harness/check-references.ts [--tasks ngn-bank-offramp,zar-bank-onramp]
```

A full run builds each job with a coding agent (`claude -p`), then grades and reports:

```bash
cd benchmarks
EVAL_OUT=/tmp/gs-bench EVAL_PG_BIN=<pg bin> \
  node --experimental-strip-types harness/run.ts --arms neutral --tasks ngn-bank-offramp,kes-bank-offramp-returns --reps 2
```

Arms: `neutral` (plugin installed, prompt does not name it), `neutralpy` (same, Python app), `plugin` (prompt names
the plugin), `docs` (public docs only). Grade with nothing else running on the machine: parallel apps compete for
ports and CPU and fail scenarios that would pass (`--grade-concurrency 1`). Results land in `$EVAL_OUT/results.md`.
