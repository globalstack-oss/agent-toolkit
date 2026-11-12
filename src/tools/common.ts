import { z } from 'zod';

export const idWithPrefix = (prefix: string, what: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`), `A ${what} id starts with ${prefix}_`);

export const countryCode = z.string().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2, e.g. NG').transform((v) => v.toUpperCase());
export const currencyCode = z.string().regex(/^[A-Za-z0-9]{2,10}$/).transform((v) => v.toUpperCase());
export const dateFilter = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/, 'YYYY-MM-DD or an ISO 8601 UTC timestamp ending in Z');

export const pagination = {
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(200).optional(),
};

/** Money-movement failure codes, from the public "Failure reasons" page. */
const MONEY_FAILURES: Record<string, { meaning: string; next_step: string }> = {
  insufficient_funds: {
    meaning: 'There were not enough funds to complete this transaction.',
    next_step: 'Fund the source wallet, then create a new quote.',
  },
  funding_failed: {
    meaning: 'The funding transfer could not be completed. No funds moved.',
    next_step: 'Create a new quote and execute again.',
  },
  temporarily_unavailable: {
    meaning: 'The transaction could not be completed right now.',
    next_step: 'Retry later with backoff, on a new quote.',
  },
  cancelled: { meaning: 'The transaction was cancelled.', next_step: 'Create a new quote if the payment is still wanted.' },
  reversed: { meaning: 'The transaction was reversed.', next_step: 'Check the payout details, then create a new quote.' },
  failed: {
    meaning: 'The transaction could not be completed. The reason is not shared.',
    next_step: 'Check the details (for a payout, with validate_payout_details), then create a new quote. If it fails again, contact Global Stack support with the id.',
  },
};

export function explainFailure(code: unknown): { code: string; meaning: string; next_step: string } | null {
  if (typeof code !== 'string' || code === '') return null;
  const known = MONEY_FAILURES[code];
  return known
    ? { code, ...known }
    : { code, meaning: 'Unknown failure code.', next_step: 'Contact Global Stack support with the id.' };
}

/** Final states per the code check (2026-09-30). `returned` can still follow `success`. */
const FINAL_STATES: Record<string, readonly string[]> = {
  onramp: ['success', 'failed', 'returned'],
  offramp: ['success', 'failed', 'returned'],
  conversion: ['success', 'failed', 'returned'],
  transfer: ['success', 'failed'],
  deposit: ['confirmed', 'failed'],
};

export function isFinal(type: unknown, status: unknown): boolean | null {
  if (typeof type !== 'string' || typeof status !== 'string') return null;
  const states = FINAL_STATES[type];
  return states ? states.includes(status) : null;
}
