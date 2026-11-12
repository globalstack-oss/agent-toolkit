// Records the real account's read-only state once, for the eval. GET requests only: nothing is
// created, changed or paid. Run it yourself with your key in the environment:
//
//   GLOBALSTACK_API_KEY=... node --experimental-strip-types benchmarks/snapshot/record.ts
//
// It writes snapshot/raw.json (raw API responses) and prints a summary. Personal data is scrubbed
// before saving: customer names, emails, phones, addresses, account numbers and webhook URLs.
import { writeFileSync } from 'node:fs';

const BASE = process.env.GLOBALSTACK_API_BASE_URL ?? 'https://api.globalstack.io';
const KEY = process.env.GLOBALSTACK_API_KEY;
if (!KEY) {
  console.error('Set GLOBALSTACK_API_KEY first.');
  process.exit(1);
}

const COUNTRIES = ['NG', 'KE', 'CM', 'ZA', 'GH', 'SN', 'CI'];
const RATE_CODES = ['NGN', 'KES', 'XAF', 'ZAR', 'GHS'];

async function get(path: string): Promise<unknown> {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${KEY}` } });
  const body = (await res.json()) as unknown;
  return { path, status: res.status, body };
}

/** Follows page/per_page pagination until has_more is false. */
async function getAll(path: string): Promise<unknown[]> {
  const pages: unknown[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = (await get(`${path}${sep}page=${page}&per_page=100`)) as { body: { meta?: { has_more?: boolean } } };
    pages.push(r);
    if (!r.body?.meta?.has_more) break;
  }
  return pages;
}

const SCRUB_KEYS = /^(first_name|last_name|middle_name|name|business_name|email|phone|phone_number|address|line1|line2|city|postal_code|date_of_birth|id_number|registration_number|account_number|account_name|url|wallet_address|address_line_1|address_line_2)$/;

function scrub(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  // Keep catalog names (providers, countries, currencies): only scrub under customer-ish objects.
  if (typeof value === 'string' && SCRUB_KEYS.test(key) && !/^(prov|ctry)_/.test(value)) return `<${key}>`;
  return value;
}

const recorded = {
  recorded_at: new Date().toISOString(),
  me: await get('/v1/me'),
  currencies: await getAll('/v1/currencies/'),
  access_requests: await getAll('/v1/currencies/access-requests'),
  countries: await getAll('/v1/countries/'),
  providers: Object.fromEntries(await Promise.all(COUNTRIES.map(async (c) => [c, await getAll(`/v1/countries/${c}/providers`)]))),
  rates: Object.fromEntries(await Promise.all(RATE_CODES.map(async (c) => [c, await get(`/v1/currencies/${c}/rates`)]))),
  customers: await getAll('/v1/customers'),
  wallets: await getAll('/v1/wallets'),
  beneficiaries: await getAll('/v1/beneficiaries'),
  webhooks: await getAll('/v1/notifications/webhooks'),
};

// Providers and countries keep their names (public catalog); everything else is scrubbed.
const { providers, countries, currencies, rates, ...rest } = recorded;
const out = { providers, countries, currencies, rates, ...(scrub(rest) as object) };
writeFileSync(new URL('./raw.json', import.meta.url), JSON.stringify(out, null, 2));

const count = (pages: unknown[]) =>
  (pages as Array<{ body?: { data?: unknown[] } }>).reduce((n, p) => n + (Array.isArray(p.body?.data) ? p.body!.data!.length : 0), 0);
console.log('Saved snapshot/raw.json');
console.log(`currencies ${count(currencies)}, countries ${count(countries)}, customers ${count(recorded.customers)}, wallets ${count(recorded.wallets)}`);
for (const c of COUNTRIES) console.log(`providers ${c}: ${count(providers[c] as unknown[])}`);
