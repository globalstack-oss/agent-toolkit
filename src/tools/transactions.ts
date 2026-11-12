import { z } from 'zod';
import { buildPath, type ApiResult, type ScopedClient } from '../api/client';
import { currencyCode, dateFilter, explainFailure, idWithPrefix, isFinal, pagination } from './common';
import { defineTool } from './types';

/** Detail endpoints carry `failure_reason`; the unified transaction row does not. */
const DETAIL_PATHS: Record<string, { type: string; path: string; param: string }> = {
  onr: { type: 'onramp', path: '/v1/onramps/{onrampId}', param: 'onrampId' },
  ofr: { type: 'offramp', path: '/v1/offramps/{offrampId}', param: 'offrampId' },
  con: { type: 'conversion', path: '/v1/conversions/{conversionId}', param: 'conversionId' },
  tfr: { type: 'transfer', path: '/v1/transfers/{transferId}', param: 'transferId' },
};

const MAX_REFERENCE_PAGES = 5;

function prefixOf(id: string): string {
  return id.split('_')[0] ?? '';
}

function fetchDetail(api: ScopedClient, id: string): Promise<ApiResult> | null {
  const detail = DETAIL_PATHS[prefixOf(id)];
  return detail ? api.request('GET', buildPath(detail.path, { [detail.param]: id })) : null;
}

const STALE_LIST_NOTE =
  'List statuses can lag behind the payment (a failed payout can still read processing). Before acting on one payment, call get_transaction with its id.';

/** Where the status came from, and whether the list row disagrees with the payment's own record. */
function statusSource(row: any, detail: ApiResult | null) {
  if (!detail) return { status_source: 'transaction_row' };
  if (!detail.ok) return { status_source: 'transaction_row', detail_fetch_failed: detail.code };
  const detailStatus = (detail.data as any)?.status;
  return { status_source: 'payment_record', ...(row?.status && detailStatus && row.status !== detailStatus ? { status_mismatch: { list: row.status, payment: detailStatus } } : {}) };
}

function summarise(type: unknown, record: any) {
  return {
    type,
    status: record?.status ?? null,
    is_final: isFinal(type, record?.status),
    may_still_be_returned: record?.status === 'success' && type !== 'transfer' ? true : undefined,
    failure: explainFailure(record?.failure_reason),
  };
}

export const getTransaction = defineTool({
  name: 'get_transaction',
  title: 'Get a transaction',
  description: [
    'With id (txn_, onr_, ofr_, con_ or tfr_): returns the record, whether its status is final, and any failure in plain words with the next step.',
    'Without id: lists transactions with filters; list statuses can lag, so check one payment by id before acting on it. With reference: finds the payment with that merchant reference.',
    'The API has no reference filter, so the tool pages through the results (narrow with created_after).',
  ].join(' '),
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/transactions' },
    { method: 'GET', path: '/v1/transactions/{transactionId}' },
    ...Object.values(DETAIL_PATHS).map(({ path }) => ({ method: 'GET' as const, path })),
  ],
  inputSchema: {
    id: z
      .string()
      .regex(/^(txn|onr|ofr|con|tfr)_[A-Za-z0-9_]+$/, 'An id that starts with txn_, onr_, ofr_, con_ or tfr_')
      .optional(),
    reference: z.string().min(1).max(128).optional().describe('Your merchant reference.'),
    type: z.enum(['onramp', 'offramp', 'conversion', 'transfer', 'deposit']).optional(),
    status: z
      .enum(['created', 'awaiting_deposit', 'processing', 'temporary_failure', 'success', 'failed', 'returned', 'received', 'confirmed'])
      .optional(),
    customer_id: idWithPrefix('cust', 'customer').optional(),
    wallet_id: idWithPrefix('wal', 'wallet').optional(),
    source_currency: currencyCode.optional(),
    created_after: dateFilter.optional(),
    created_before: dateFilter.optional(),
    ...pagination,
  },
  async run({ id, reference, ...filters }, api) {
    if (id) {
      if (prefixOf(id) !== 'txn') {
        const detail = await fetchDetail(api, id)!;
        if (!detail.ok) return detail;
        return { ok: true, ...summarise(DETAIL_PATHS[prefixOf(id)]!.type, detail.data), record: detail.data };
      }
      const txn = await api.request('GET', buildPath('/v1/transactions/{transactionId}', { transactionId: id }));
      if (!txn.ok) return txn;
      const row = txn.data as any;
      const detail = typeof row?.source_id === 'string' ? fetchDetail(api, row.source_id) : null;
      const detailResult = detail ? await detail : null;
      const record = detailResult?.ok ? detailResult.data : null;
      return { ok: true, ...summarise(row?.type, record ?? row), ...statusSource(row, detailResult), transaction: row, detail: record ?? undefined };
    }

    if (!reference) {
      const list = await api.request('GET', '/v1/transactions', { query: filters });
      return list.ok ? { ...list, note: STALE_LIST_NOTE } : list;
    }

    for (let page = 1; page <= MAX_REFERENCE_PAGES; page++) {
      const result = await api.request('GET', '/v1/transactions', { query: { ...filters, page, per_page: 200 } });
      if (!result.ok) return result;
      const match = (result.data as any[]).find((row) => row?.reference === reference);
      if (match) {
        // The unified row can lag (a failed offramp can still read processing); trust the detail record.
        const detail = typeof match.source_id === 'string' ? await fetchDetail(api, match.source_id) : null;
        const record = detail?.ok ? detail.data : null;
        return { ok: true, found: true, ...summarise(match.type, record ?? match), ...statusSource(match, detail), transaction: match, detail: record ?? undefined };
      }
      if (!(result.meta as any)?.has_more) return { ok: true, found: false, searched_pages: page };
    }
    return {
      ok: true,
      found: false,
      searched_pages: MAX_REFERENCE_PAGES,
      hint: `Stopped after ${MAX_REFERENCE_PAGES * 200} transactions. Narrow the search with created_after, type or customer_id.`,
    };
  },
});
