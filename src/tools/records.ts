import { z } from 'zod';
import { buildPath } from '../api/client';
import { currencyCode, idWithPrefix, pagination } from './common';
import { defineTool } from './types';

/** Profile fields a quote needs, per customer type (from the create-a-customer docs). */
const QUOTE_FIELDS: Record<string, readonly string[]> = {
  individual: ['phone', 'date_of_birth', 'id_number', 'id_type', 'address'],
  business: ['phone', 'business_licence'],
};

export function missingQuoteFields(customer: any): string[] | null {
  const fields = QUOTE_FIELDS[customer?.type];
  if (!fields) return null;
  const profile = customer.profile ?? {};
  return fields.filter((field) => !profile[field]);
}

export const getCustomer = defineTool({
  name: 'get_customer',
  title: 'Get customers',
  description: [
    'With customer_id: returns the customer, their KYC verification session, and the profile fields a quote still needs.',
    'Without: lists customers, filtered by type and kyc_status.',
  ].join(' '),
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/customers' },
    { method: 'GET', path: '/v1/customers/{customerId}' },
    { method: 'GET', path: '/v1/customers/{customerId}/verifications' },
  ],
  inputSchema: {
    customer_id: idWithPrefix('cust', 'customer').optional(),
    type: z.enum(['individual', 'business']).optional(),
    kyc_status: z.enum(['not_started', 'pending', 'in_progress', 'approved', 'rejected', 'expired']).optional(),
    ...pagination,
  },
  async run({ customer_id, ...filters }, api) {
    if (!customer_id) return api.request('GET', '/v1/customers', { query: filters });

    const params = { customerId: customer_id };
    const [customer, verification] = await Promise.all([
      api.request('GET', buildPath('/v1/customers/{customerId}', params)),
      api.request('GET', buildPath('/v1/customers/{customerId}/verifications', params)),
    ]);
    if (!customer.ok) return customer;

    const missing = missingQuoteFields(customer.data);
    return {
      ok: true,
      customer: customer.data,
      verification: verification.ok
        ? verification.data
        : verification.status === 404
          ? (customer.data as any)?.kyc_status === 'approved'
            ? { none: true }
            : { none: true, next_step: 'No KYC session yet. Start one with start_verification.' }
          : verification,
      missing_for_quote:
        missing === null
          ? 'Unknown customer type: not checked.'
          : missing.length
            ? { fields: missing, effect: 'A quote for this customer can fail with 400 until these are set (update_customer).' }
            : [],
    };
  },
});

export const getWallet = defineTool({
  name: 'get_wallet',
  title: 'Get wallets',
  description: [
    'With wallet_id: returns the wallet with balances, and in receive_at the only addresses a payer may send to (active ones). Disabled addresses are hidden.',
    'Without: lists wallets with balances, filtered by customer_id and currency (max 50 per page).',
  ].join(' '),
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/wallets' },
    { method: 'GET', path: '/v1/wallets/{walletId}' },
    { method: 'GET', path: '/v1/wallets/{id}/deposit-addresses' },
  ],
  inputSchema: {
    wallet_id: idWithPrefix('wal', 'wallet').optional(),
    customer_id: idWithPrefix('cust', 'customer').optional(),
    currency: currencyCode.optional(),
    page: pagination.page,
    per_page: z.number().int().min(1).max(50).optional(),
    include_inactive: z.boolean().optional().describe('Also list disabled addresses. Never give them to a payer.'),
  },
  async run({ wallet_id, include_inactive, ...filters }, api) {
    if (!wallet_id) return api.request('GET', '/v1/wallets', { query: filters });

    const [wallet, addresses] = await Promise.all([
      api.request('GET', buildPath('/v1/wallets/{walletId}', { walletId: wallet_id })),
      api.request('GET', buildPath('/v1/wallets/{id}/deposit-addresses', { id: wallet_id }), { query: { per_page: 200 } }),
    ]);
    if (!wallet.ok) return wallet;
    const w: any = wallet.data;
    const credentials = Array.isArray(w?.credentials) ? w.credentials : [];
    const deposits = addresses.ok && Array.isArray(addresses.data) ? (addresses.data as any[]) : [];
    const isActive = (r: any) => r?.status === 'active';
    const inactive = [...credentials, ...deposits].filter((r) => !isActive(r));
    return {
      ok: true,
      receive_at: [...credentials, ...deposits].filter(isActive).map(receiveInstruction),
      wallet: { ...w, credentials: credentials.filter(isActive) },
      deposit_addresses: addresses.ok ? deposits.filter(isActive) : addresses,
      ...(inactive.length
        ? {
            inactive_do_not_send: include_inactive
              ? inactive.map((r) => ({ id: r.id, status: r.status ?? 'unknown', address: r.details?.address ?? r.details?.account_number }))
              : `${inactive.length} inactive or unverified address(es) hidden. Money sent to them is not credited. Pass include_inactive to list them.`,
          }
        : {}),
    };
  },
});

/** Where money can be sent to reach this wallet. Only active destinations. */
function receiveInstruction(r: any) {
  return { id: r.id, currency: r.currency ?? null, network: r.details?.network ?? r.network ?? null, details: r.details ?? null };
}

export const listBeneficiaries = defineTool({
  name: 'list_beneficiaries',
  title: 'Get beneficiaries',
  description: 'With beneficiary_id: returns one beneficiary. Without: lists beneficiaries, filtered by customer_id, type and currency.',
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/beneficiaries' },
    { method: 'GET', path: '/v1/beneficiaries/{beneficiaryId}' },
  ],
  inputSchema: {
    beneficiary_id: idWithPrefix('ben', 'beneficiary').optional(),
    customer_id: idWithPrefix('cust', 'customer').optional(),
    type: z.enum(['fiat', 'crypto']).optional(),
    currency: currencyCode.optional(),
    ...pagination,
  },
  async run({ beneficiary_id, ...filters }, api) {
    if (beneficiary_id) return api.request('GET', buildPath('/v1/beneficiaries/{beneficiaryId}', { beneficiaryId: beneficiary_id }));
    return api.request('GET', '/v1/beneficiaries', { query: filters });
  },
});

export const getQuote = defineTool({
  name: 'get_quote',
  title: 'Get a quote',
  description:
    'Returns a quote and how long it has left. The status does not show whether an execute was tried: after a failed execute it can still read active. To check an execute, use get_transaction with the reference.',
  group: 'read',
  calls: [{ method: 'GET', path: '/v1/quotes/{quoteId}' }],
  inputSchema: { quote_id: idWithPrefix('quo', 'quote') },
  async run({ quote_id }, api) {
    const result = await api.request('GET', buildPath('/v1/quotes/{quoteId}', { quoteId: quote_id }));
    if (!result.ok) return result;
    const expiresAt = Date.parse((result.data as any)?.expires_at ?? '');
    return {
      ...result,
      seconds_left: Number.isNaN(expiresAt) ? null : Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
    };
  },
});

export const getWebhooks = defineTool({
  name: 'get_webhooks',
  title: 'Get webhook endpoints',
  description:
    'Without webhook_id: lists webhook endpoints. With webhook_id: returns the endpoint, its recent delivery attempts, and the events waiting to be sent. Signing secrets are never returned.',
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/notifications/webhooks' },
    { method: 'GET', path: '/v1/notifications/webhooks/{id}' },
    { method: 'GET', path: '/v1/notifications/webhooks/{id}/logs' },
    { method: 'GET', path: '/v1/notifications/webhooks/{id}/events' },
  ],
  inputSchema: {
    webhook_id: idWithPrefix('whr', 'webhook endpoint').optional(),
    logs_per_page: z.number().int().min(1).max(200).optional().describe('Delivery attempts to return. Default 20.'),
  },
  async run({ webhook_id, logs_per_page }, api) {
    if (!webhook_id) return api.request('GET', '/v1/notifications/webhooks');
    const params = { id: webhook_id };
    const [endpoint, logs, queued] = await Promise.all([
      api.request('GET', buildPath('/v1/notifications/webhooks/{id}', params)),
      api.request('GET', buildPath('/v1/notifications/webhooks/{id}/logs', params), { query: { per_page: logs_per_page ?? 20 } }),
      api.request('GET', buildPath('/v1/notifications/webhooks/{id}/events', params)),
    ]);
    if (!endpoint.ok) return endpoint;
    return {
      ok: true,
      endpoint: endpoint.data,
      recent_deliveries: logs.ok ? logs.data : logs,
      queued_events: queued.ok ? queued.data : queued,
    };
  },
});
