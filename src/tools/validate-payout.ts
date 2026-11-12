import { z } from 'zod';
import { buildPath, type ScopedClient } from '../api/client';
import { countryCode, currencyCode, idWithPrefix } from './common';
import { defineTool } from './types';

/** Checked with the provider when the beneficiary is created (code check, ground truth 5). */
const RESOLVED_AT_CREATION = new Set(['NGN:bank', 'GHS:bank', 'KES:mobile_money']);
/** The bank's account name replaces the one sent, and cannot be changed later. */
const NAME_FROM_BANK = new Set(['NGN:bank', 'GHS:bank']);
const ZAR_NAME_MAX = 30;

/** What the ZAR provider does to a name at quote time: fold to ASCII, then cut to 30 characters. */
export function zarNamePreview(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, ZAR_NAME_MAX);
}

export const payoutDetailsSchema = {
  country_code: countryCode,
  currency: currencyCode,
  network: z.enum(['bank', 'mobile_money']),
  provider_id: z.string().optional().describe('The prov_ id from list_supported_routes. Not a bank code.'),
  account_number: z.string().describe('Bank account number, or the phone number for mobile money.'),
  account_name: z.string().optional().describe('The name on the account.'),
  name: z.string().optional().describe('The beneficiary name, if different from account_name.'),
  customer_id: idWithPrefix('cust', 'customer').optional(),
  usdc_amount: z.string().optional().describe('USDC source_amount you plan to quote, as a decimal string.'),
};

export const PAYOUT_CHECK_CALLS = [
  { method: 'GET', path: '/v1/countries/{countryCode}/providers' },
  { method: 'GET', path: '/v1/customers/{customerId}' },
] as const;

type PayoutDetails = z.infer<z.ZodObject<typeof payoutDetailsSchema>>;

/** Shared by validate_payout_details and create_beneficiary. */
export async function checkPayoutDetails(args: PayoutDetails, api: ScopedClient) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const key = `${args.currency}:${args.network}`;
  const payeeName = (args.account_name ?? args.name ?? '').trim();

  // Provider
  if (!args.provider_id) {
    errors.push('provider_id is required. Get it from list_supported_routes with providers_for_country.');
  } else if (!args.provider_id.startsWith('prov_')) {
    errors.push(`"${args.provider_id}" is not a provider_id. A bank code or network code fails. Use the prov_ id from list_supported_routes.`);
  } else {
    const providers = await api.request('GET', buildPath('/v1/countries/{countryCode}/providers', { countryCode: args.country_code }), {
      query: { network: args.network },
    });
    if (!providers.ok) return providers;
    const provider = (providers.data as any[]).find((p) => p?.id === args.provider_id);
    if (!provider) errors.push(`provider_id ${args.provider_id} is not a ${args.network} provider in ${args.country_code}.`);
    else if (provider.active === false) errors.push(`${provider.name} is not accepting payouts right now (inactive).`);
    else notes.push(`Provider: ${provider.name}.`);
  }

  // Account number
  const account = args.account_number.trim();
  if (account.length < 1 || account.length > 64) errors.push('account_number must be 1 to 64 characters.');
  if (args.network === 'bank' && !/^\d+$/.test(account)) {
    warnings.push('The account number is not all digits. The API accepts it, but the payout rail can reject it ("only numeric values allowed").');
  }
  if (args.network === 'mobile_money' && !/^\+?\d{7,15}$/.test(account.replace(/[\s-]/g, ''))) {
    warnings.push('For mobile money, account_number is the phone number. It does not look like one.');
  }

  // Names
  if (!payeeName && !NAME_FROM_BANK.has(key)) {
    errors.push(`account_name is required for ${args.currency} ${args.network}.`);
  }
  if (NAME_FROM_BANK.has(key)) {
    notes.push(`${args.currency} bank: the bank's account name replaces the one you send, and it cannot be changed later.`);
  }
  if (payeeName && !NAME_FROM_BANK.has(key) && payeeName.split(/\s+/).length < 2) {
    warnings.push(
      'The name is one word. The API accepts it, but the receiving bank or rail may reject it ("recipient name must include both a first name and a last name"). Do not refuse: ask for the full name exactly as on the account, and test with the minimum amount first.',
    );
  }
  if (payeeName && args.currency === 'GHS') {
    const [first, ...rest] = payeeName.split(/\s+/);
    notes.push(`GHS splits the name at the first space: first name "${first}", last name "${rest.join(' ')}".`);
  }
  if (payeeName && args.currency === 'ZAR') {
    const preview = zarNamePreview(payeeName);
    if (preview !== payeeName) warnings.push(`ZAR: the name will be sent as "${preview}" (plain letters, max ${ZAR_NAME_MAX} characters).`);
  }

  // Customer
  if (!args.customer_id) {
    warnings.push(
      "No customer_id. The beneficiary goes to the integration's default customer. A quote from a wallet that belongs to another customer then fails with 404.",
    );
  } else {
    const customer = await api.request('GET', buildPath('/v1/customers/{customerId}', { customerId: args.customer_id }));
    if (!customer.ok) errors.push(`customer_id ${args.customer_id}: ${customer.code}.`);
  }

  // Amount
  if (args.usdc_amount !== undefined) {
    const match = args.usdc_amount.match(/^\d+(?:\.(\d+))?$/);
    if (!match) errors.push('usdc_amount must be a positive decimal string, e.g. "25.50".');
    else if ((match[1] ?? '').replace(/0+$/, '').length > 2) {
      const [whole, fraction = ''] = args.usdc_amount.split('.');
      errors.push(`USDC amounts have at most 2 decimals. Round down to "${whole}.${fraction.slice(0, 2)}".`);
    }
  }

  return {
    ok: true,
    /** Only these input checks. It does not mean the account exists or belongs to this person. */
    input_checks_passed: errors.length === 0,
    account_existence: 'not_checked',
    errors,
    warnings,
    notes,
    checked_by_api_at_creation: RESOLVED_AT_CREATION.has(key)
      ? `Yes: the account is checked with the provider when the beneficiary is created.`
      : `No: ${args.currency} ${args.network} accounts are not checked at creation. A wrong account fails only at quote or payout time.`,
  };
}

export const validatePayoutDetails = defineTool({
  name: 'validate_payout_details',
  title: 'Check payout details',
  description: [
    'Checks fiat payout details before a beneficiary is created or money moves. Creates nothing.',
    'Catches problems the API accepts at creation but that fail later at quote or payout time:',
    'wrong or inactive provider, a bank code in place of a provider_id, a non-numeric account number, a one-word name,',
    'a missing customer_id, name changes by the payout rail, and USDC amounts with more than 2 decimals.',
    'It does not check that the account exists or who owns it: input_checks_passed is not proof of a real account.',
  ].join(' '),
  group: 'read',
  calls: PAYOUT_CHECK_CALLS,
  inputSchema: payoutDetailsSchema,
  run: (args, api) => checkPayoutDetails(args, api),
});
