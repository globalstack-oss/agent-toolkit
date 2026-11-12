// The account the sandbox starts from. Catalog rows (currencies, providers) were recorded from the real
// account (globalstack-testing/catalog.json); customers, wallets and known payout accounts are fixtures.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CurrencyRow, Seed } from './api.ts';

/**
 * The recorded catalog. The bundled sandbox.mjs lives in globalstack-testing/scripts/, next to ../catalog.json.
 * GLOBALSTACK_CATALOG points elsewhere: the plugin's own tests use it to run the simulator from src/.
 */
const catalogPath = () => process.env.GLOBALSTACK_CATALOG ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json');

export const EVAL_IDS = {
  integrationId: 'int_01M4F0J8Q2T3V5W6X7Y8Z9A0B1',
  defaultCustomerId: 'cust_01M4F0J8Q2T3V5W6X7Y8Z9A0C2',
  treasuryCustomerId: 'cust_01M4F0J8Q2T3V5W6X7Y8Z9A0D3',
  usdcWalletId: 'wal_01M4F0J8Q2T3V5W6X7Y8Z9A0E4',
  ngnWalletId: 'wal_01M4F0J8Q2T3V5W6X7Y8Z9A0F5',
};

const T0 = '2026-09-01T09:00:00.000Z';

interface Snapshot {
  routes: Array<Record<string, any>>;
  providers: Record<string, Array<{ id: string; name: string; code: string; network: string; active: boolean }>>;
}

function loadSnapshot(): Snapshot {
  const path = catalogPath();
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

const COUNTRY_NAMES: Record<string, string> = { NG: 'Nigeria', KE: 'Kenya', CM: 'Cameroon', ZA: 'South Africa', GH: 'Ghana' };
const CURRENCY_NAMES: Record<string, string> = { NGN: 'Nigerian Naira', KES: 'Kenyan Shilling', XAF: 'Central African CFA Franc', ZAR: 'South African Rand', GHS: 'Ghanaian Cedi', USDC: 'USD Coin' };
const PRECISION: Record<string, number> = { NGN: 2, KES: 2, XAF: 0, ZAR: 2, GHS: 2, USDC: 6 };

/** Real routes as /v1/currencies rows. XAF in Cameroon is gated (code check: requires_access). */
function currencies(snapshot: Snapshot): CurrencyRow[] {
  const rows: CurrencyRow[] = snapshot.routes.map((r) => ({
    code: r.currency,
    name: CURRENCY_NAMES[r.currency] ?? r.currency,
    type: 'fiat',
    precision: PRECISION[r.currency] ?? 2,
    country_code: r.country_code,
    can_onramp: Boolean(r.can_onramp),
    can_offramp: Boolean(r.can_offramp),
    can_transfer: Boolean(r.can_transfer),
    can_deposit: Boolean(r.can_deposit),
    can_convert: Boolean(r.can_convert),
    requires_access: r.currency === 'XAF',
    networks: r.networks,
    fees: r.fees,
    created_at: T0,
    updated_at: T0,
  }));
  rows.push({
    code: 'USDC', name: 'USD Coin', type: 'crypto', precision: 6, can_onramp: true, can_offramp: true, can_transfer: true, can_deposit: true,
    can_convert: true, requires_access: false,
    networks: ['base', 'solana', 'ethereum'].map((network) => ({ network, inbound: { min: '2.50', max: '100000.00' }, outbound: { min: '2.50', max: '100000.00' } })),
    created_at: T0, updated_at: T0,
  });
  return rows;
}

export interface SeedOptions {
  /** XAF access request state at the start: the real account has one pending. */
  xafAccess?: 'pending' | 'approved';
  usdcBalance?: string;
}

export function buildSeed(options: SeedOptions = {}): Seed {
  const snapshot = loadSnapshot();
  const providers = { ...snapshot.providers };
  providers.GH ??= [
    { id: 'prov_01M4EVALGHGCB00000000000000', name: 'GCB Bank', code: '040100', network: 'bank', active: true },
    { id: 'prov_01M4EVALGHECO00000000000000', name: 'Ecobank Ghana', code: '130100', network: 'bank', active: true },
  ];
  // The recorded catalog has no ZA provider rows although ZAR (ZA) is open for offramp. These use the real
  // ZA provider codes the API maps to banks, so the account number rules apply.
  providers.ZA ??= [
    { id: 'prov_01M4EZA0000000000000000001', name: 'Absa Bank', code: '632005', network: 'bank', active: true },
    { id: 'prov_01M4EZA0000000000000000002', name: 'Capitec Bank', code: '470010', network: 'bank', active: true },
    { id: 'prov_01M4EZA0000000000000000003', name: 'First National Bank', code: '250655', network: 'bank', active: true },
    { id: 'prov_01M4EZA0000000000000000004', name: 'Nedbank', code: '198765', network: 'bank', active: true },
    { id: 'prov_01M4EZA0000000000000000005', name: 'Standard Bank', code: '051001', network: 'bank', active: true },
    { id: 'prov_01M4EZA0000000000000000006', name: 'TymeBank', code: 'TYME_BANK', network: 'bank', active: true },
  ];
  const profile = { phone: '+2348000000000', address: '1 Marina, Lagos', business_licence: 'RC-1234567' };
  return {
    integrationId: EVAL_IDS.integrationId,
    developerId: EVAL_IDS.integrationId,
    role: 'consumer_developer',
    defaultCustomerId: EVAL_IDS.defaultCustomerId,
    customers: [
      // The merchant's own business, onboarded with a full profile. Quotes for a new (tier_0) customer use its profile.
      { id: EVAL_IDS.defaultCustomerId, type: 'business', name: 'Eval Merchant (default)', email: 'default@eval.test', merchant_reference: 'default', country_code: 'NG', tier: 'tier_0', kyc_status: 'not_started', profile: { phone: '+2348000000001', address: '2 Marina, Lagos', business_licence: 'RC-7654321' } },
      { id: EVAL_IDS.treasuryCustomerId, type: 'business', name: 'Eval Fintech Ltd', email: 'treasury@eval.test', merchant_reference: 'treasury', country_code: 'NG', tier: 'tier_2', kyc_status: 'approved', profile },
    ],
    wallets: [
      { id: EVAL_IDS.usdcWalletId, customer_id: EVAL_IDS.treasuryCustomerId, currency: 'USDC', label: 'Treasury', available: options.usdcBalance ?? '10000.00' },
      { id: EVAL_IDS.ngnWalletId, customer_id: EVAL_IDS.treasuryCustomerId, currency: 'NGN', label: 'Suppliers', available: '0.00' },
    ],
    currencies: currencies(snapshot),
    countries: [
      { code: 'NG', name: COUNTRY_NAMES.NG!, currencies: ['NGN'], networks: ['bank'] },
      { code: 'KE', name: COUNTRY_NAMES.KE!, currencies: ['KES'], networks: ['bank', 'mobile_money'] },
      { code: 'CM', name: COUNTRY_NAMES.CM!, currencies: ['XAF'], networks: ['mobile_money'] },
      { code: 'ZA', name: COUNTRY_NAMES.ZA!, currencies: ['ZAR'], networks: ['bank'] },
      { code: 'GH', name: COUNTRY_NAMES.GH!, currencies: ['GHS'], networks: ['bank', 'mobile_money'] },
    ],
    providers,
    accessRequests: [{ code: 'XAF', country_code: 'CM', status: options.xafAccess ?? 'approved' }],
    rates: { NGN: '1530.50', KES: '129.20', XAF: '571.40', ZAR: '17.70', GHS: '15.40' },
    knownAccounts: {
      // Nigerian bank accounts: any NG bank code resolves these numbers (resolution is by bank and number).
      '*:0123456789': 'ADA OBI',
      '*:0987654321': 'TUNDE BELLO',
      '*:2233445566': 'NGOZI OKAFOR',
      // M-Pesa numbers exist (KES mobile money is checked at creation, the sent name is kept).
      'mpesa_mobile_money:+254712345678': 'WANJIKU KAMAU',
      'mpesa_mobile_money:+254722000111': 'OTIENO ODHIAMBO',
      'mpesa_mobile_money:254712345678': 'WANJIKU KAMAU',
      'mpesa_mobile_money:254722000111': 'OTIENO ODHIAMBO',
      'mpesa_mobile_money:0712345678': 'WANJIKU KAMAU',
      'mpesa_mobile_money:0722000111': 'OTIENO ODHIAMBO',
      // PayShap proxies (ZAR rail payshap): the holder's bank and name come from the proxy.
      'payshap:+27821234567': 'THANDI MOKOENA',
      'payshap:sipho@capitec': 'SIPHO DLAMINI',
    },
  };
}
