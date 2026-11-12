// The sandbox's faults: what each one does and what correct code does about it. Shared by sandbox.mjs and by
// gs.mjs build_check_acceptance, which reads back which faults an app folder was tested against.
export const FAULTS = ['none', 'lost_response', 'provider_error', 'rate_limit', 'webhook_silence', 'webhook_noise', 'slow_final'] as const;
export type Fault = (typeof FAULTS)[number];

/** Under slow_final, movements stay processing until the sandbox clock has moved this far. */
export const SLOW_FINAL_HOURS = 3;

export interface FaultInfo {
  what_happens: string;
  correct_code: string;
  /** What to check in the app's own records after the run: the sandbox only sees the API calls. */
  check_in_app: string[];
}

const BOOKS_ONCE = "The user's balance in your database changed once, by the amount GlobalStack reports.";

export const FAULT_INFO: Record<Fault, FaultInfo> = {
  none: {
    what_happens: 'No fault. Everything succeeds and webhooks arrive once, in order.',
    correct_code: 'Finishes the flow from the final webhook, once.',
    check_in_app: ['The payment is completed in your app.', BOOKS_ONCE],
  },
  lost_response: {
    what_happens: 'The next execute (POST /v1/offramps, /onramps, /conversions or /transfers) succeeds, but the response is dropped.',
    correct_code: 'Treat the outcome as unknown. Find the movement by your reference (or resend the saved request: same body, same Idempotency-Key). Never pay twice.',
    check_in_app: ['One payment record for the request, completed, holding the one movement id in this report.', BOOKS_ONCE, 'No refund, and the user was not told the payment failed.'],
  },
  provider_error: {
    what_happens: 'The next execute fails at the provider: it answers 500 external_service_unavailable, and a wallet payout is stored as failed. It does not fire for bank onramps.',
    correct_code: 'Treat the outcome as unknown and look it up by reference. Once it is failed or missing, retry on your own, without the user asking again: the next attempt number in the reference, and a new quote if the flow uses quotes.',
    check_in_app: ['The payment completed on a later attempt, with no action from the user.', BOOKS_ONCE, 'No refund was made for the failed attempt.'],
  },
  rate_limit: {
    what_happens: 'The next 2 money writes (quotes and executes for offramps, conversions, transfers) answer 429 rate_limited, with no Retry-After header.',
    correct_code: 'Back off and send the same request again, with the same body and Idempotency-Key.',
    check_in_app: ['The payment completed, and the user saw no error.', BOOKS_ONCE],
  },
  webhook_silence: {
    what_happens: 'No webhook is delivered.',
    correct_code: 'Poll GET /v1/{kind}s/{id} for movements that are not final, and finish them from what you read.',
    check_in_app: ['The payment is completed in your app, from polling alone.', BOOKS_ONCE],
  },
  webhook_noise: {
    what_happens: 'Every event arrives twice, a stale processing event arrives after the final one, and one forged event with a bad signature claims the opposite outcome.',
    correct_code: 'Verify each signature and answer the forged event 4xx, dedupe on event_id, and never move a final state back.',
    check_in_app: ['The payment is completed, not moved back to processing by the stale event.', `${BOOKS_ONCE} The duplicates and the forged event changed nothing.`],
  },
  slow_final: {
    what_happens: `Movements stay processing until the sandbox clock has moved ${SLOW_FINAL_HOURS} hours (sandbox.mjs advance), then succeed.`,
    correct_code: 'Keep the payment pending. Never fail or refund it on your own timeout. Finish it when GlobalStack says it is final.',
    check_in_app: ['The payment stayed pending until the clock moved, then completed.', 'No refund or failure was recorded while it was pending.', BOOKS_ONCE],
  },
};

/**
 * The faults that can happen in a flow: the rate limiter does not cover onramps, and a bank onramp has no provider
 * call at execute for provider_error to fail.
 */
export function faultsFor(direction?: string, network?: string): Fault[] {
  return FAULTS.filter((f) => {
    if (f === 'rate_limit' && direction === 'onramp') return false;
    if (f === 'provider_error' && direction === 'onramp' && network === 'bank') return false;
    return true;
  });
}
