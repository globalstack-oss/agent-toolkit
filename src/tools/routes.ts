import { z } from 'zod';
import { buildPath } from '../api/client';
import { countryCode, currencyCode, idWithPrefix } from './common';
import { defineTool } from './types';

const LIMITS_NOTE =
  'Min and max amounts are a guide only. The quote checks its own limits on the amount sent, not on the amount received (for example an offramp checks the USDC amount).';

type Row = Record<string, any>;

export function routeStatus(row: Row, accessRequests: Row[]): string {
  if (Array.isArray(row.customer_restrictions) && row.customer_restrictions.length > 0) return 'blocked_for_customer';
  if (row.requires_access && row.has_access !== true) {
    const request = accessRequests.find(
      (r) => r.resource_code === row.code && (r.country_code == null || r.country_code === row.country_code),
    );
    return request ? `access_${request.status}` : 'needs_access';
  }
  return 'open';
}

export const listSupportedRoutes = defineTool({
  name: 'list_supported_routes',
  title: 'List supported routes',
  description: [
    'Lists which currencies and countries this integration can use, and in which direction (onramp, offramp, deposit, convert).',
    'Each row says if the route is open, needs an access grant, has an access request pending, or is blocked for the given customer.',
    'Pass providers_for_country to also list the banks and mobile money operators (provider_id) for a country.',
  ].join(' '),
  group: 'read',
  calls: [
    { method: 'GET', path: '/v1/currencies' },
    { method: 'GET', path: '/v1/currencies/access-requests' },
    { method: 'GET', path: '/v1/countries/{countryCode}/providers' },
  ],
  inputSchema: {
    currency: currencyCode.optional().describe('Currency code, e.g. NGN, XAF, USDC.'),
    country_code: countryCode.optional(),
    direction: z.enum(['onramp', 'offramp', 'deposit', 'convert']).optional(),
    network: z.string().optional().describe('e.g. bank, mobile_money, solana.'),
    customer_id: idWithPrefix('cust', 'customer').optional().describe("Answers for this customer's current state (e.g. KYC)."),
    providers_for_country: countryCode.optional().describe('Also list providers for this country.'),
  },
  async run(args, api) {
    const capability = args.direction ? { [`can_${args.direction}`]: true } : {};
    const [currencies, access] = await Promise.all([
      api.request('GET', '/v1/currencies', {
        query: {
          code: args.currency,
          country_code: args.country_code,
          network: args.network,
          customer_id: args.customer_id,
          per_page: 200,
          ...capability,
        },
      }),
      api.request('GET', '/v1/currencies/access-requests'),
    ]);
    if (!currencies.ok) return currencies;

    const accessRequests = access.ok && Array.isArray(access.data) ? (access.data as Row[]) : [];
    const routes = (currencies.data as Row[]).map((row) => ({
      currency: row.code,
      country_code: row.country_code,
      type: row.type,
      status: routeStatus(row, accessRequests),
      can_onramp: row.can_onramp,
      can_offramp: row.can_offramp,
      can_deposit: row.can_deposit,
      can_convert: row.can_convert,
      can_transfer: row.can_transfer,
      networks: row.networks,
      fees: row.fees,
      customer_restrictions: row.customer_restrictions,
    }));

    let providers: unknown;
    if (args.providers_for_country) {
      const result = await api.request('GET', buildPath('/v1/countries/{countryCode}/providers', { countryCode: args.providers_for_country }), {
        query: { network: args.network, active: true },
      });
      providers = result.ok ? result.data : result;
    }

    return {
      ok: true,
      routes,
      providers,
      notes: [
        LIMITS_NOTE,
        'needs_access: request it with POST /v1/currencies/{code}/access-requests, with the country_code, after the developer agrees.',
        ...(access.ok ? [] : ['Could not read access requests, so pending requests are not shown.']),
      ],
    };
  },
});

export const getRate = defineTool({
  name: 'get_rate',
  title: 'Get a guide rate',
  description:
    'Returns the current buy and sell rates for a currency against USDC. A price guide only: nothing is created. Use it before a quote.',
  group: 'read',
  calls: [{ method: 'GET', path: '/v1/currencies/{code}/rates' }],
  inputSchema: {
    currency: currencyCode.describe('e.g. NGN, or USDC for all fiat pairs.'),
    country_code: countryCode.optional(),
  },
  async run({ currency, country_code }, api) {
    return api.request('GET', buildPath('/v1/currencies/{code}/rates', { code: currency }), { query: { country_code } });
  },
});
