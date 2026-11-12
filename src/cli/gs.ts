// gs.mjs: runs one read-only Global Stack check with the developer's own key.
//
//   node gs.mjs --list
//   node gs.mjs build_guidance '{"flow":"ngn_bank_withdraw"}'
//
// Only GET requests leave the machine: each check declares its calls, and the fetch below refuses any other method.
// Each run also reads the plugin's latest version number (update-check.ts), which sends no key. Every request names
// the plugin and its version in the User-Agent, so Global Stack can count the traffic the plugin brings.
import { z } from 'zod';
import { GlobalStackClient } from '../api/client';
import { getGsAccountInfo } from '../tools/account-info';
import { buildCheckAcceptance, buildGuidance } from '../tools/guidance';
import { getCustomer, getQuote, getWallet, getWebhooks, listBeneficiaries } from '../tools/records';
import { getRate, listSupportedRoutes } from '../tools/routes';
import { createSearchDocs } from '../tools/search-docs';
import { getTransaction } from '../tools/transactions';
import type { ToolDefinition } from '../tools/types';
import { validatePayoutDetails } from '../tools/validate-payout';
import { checkForUpdate, type PluginUpdate, type Release } from './update-check';

/** Set by build.mjs from plugin/.claude-plugin/plugin.json. */
declare const __PLUGIN__: Release;

const USER_AGENT = `globalstack-plugin/${__PLUGIN__.version}`;

const named: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('User-Agent', USER_AGENT);
  return fetch(input, { ...init, headers });
};

const checks: readonly ToolDefinition[] = [
  buildGuidance,
  buildCheckAcceptance,
  getGsAccountInfo,
  listSupportedRoutes,
  getRate,
  validatePayoutDetails,
  getCustomer,
  getWallet,
  listBeneficiaries,
  getQuote,
  getTransaction,
  getWebhooks,
  createSearchDocs(named),
];

const getOnly: typeof fetch = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return Promise.reject(new Error(`Blocked: ${method}. These scripts only read.`));
  return named(input, init);
};

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Puts the newer-version notice first in an object result, so the agent reads it before a long answer. */
async function withUpdate(value: unknown, update: Promise<PluginUpdate | null>): Promise<unknown> {
  const plugin_update = await update;
  return plugin_update && value && typeof value === 'object' && !Array.isArray(value) ? { plugin_update, ...value } : value;
}

async function main(): Promise<number> {
  const update = checkForUpdate(__PLUGIN__, process.argv[1] ?? '', { fetch: named });
  const [name, rawArgs] = process.argv.slice(2);
  if (!name || name === '--list' || name === '--help') {
    print(
      await withUpdate(
        {
          usage: "node gs.mjs <check> '<json args>'",
          key: 'Reads GLOBALSTACK_API_KEY from the environment. Never pass the key as an argument.',
          checks: checks.map((c) => ({ name: c.name, what_it_does: c.description, args: Object.keys(c.inputSchema) })),
        },
        update,
      ),
    );
    return name ? 0 : 1;
  }
  const check = checks.find((c) => c.name === name);
  if (!check) {
    print({ ok: false, code: 'unknown_check', developer_message: `No check named ${name}. Run node gs.mjs --list.` });
    return 1;
  }
  let args: unknown;
  try {
    args = z.object(check.inputSchema).strict().parse(rawArgs ? JSON.parse(rawArgs) : {});
  } catch (error) {
    print({ ok: false, code: 'invalid_input', developer_message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
  const client = new GlobalStackClient({ apiKey: process.env.GLOBALSTACK_API_KEY, baseUrl: process.env.GLOBALSTACK_API_BASE_URL, fetch: getOnly });
  print(await withUpdate(await check.run(args as never, client.scoped(check.calls)), update));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    print({ ok: false, code: 'script_error', developer_message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
