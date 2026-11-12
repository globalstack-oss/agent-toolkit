import { z } from 'zod';
import { countryCode, currencyCode } from './common';
import { runSetupChecks, SETUP_CALLS } from './check-setup';
import { loadSkill, referenceFor, SKILL_NAME, type Playbook } from '../skill';
import { faultCoverage, readRuns } from '../sandbox/coverage';
import { referenceCopies } from './reference-copies';
import { defineTool } from './types';

/** Every rule here comes from the skill file. Change the skill, not this file. */
const skill = loadSkill();
const PLAYBOOKS = Object.fromEntries(skill.playbooks.map((p) => [p.id, p]));
const GENERAL = PLAYBOOKS.general!;
const FLOW_IDS = skill.playbooks.filter((p) => p.route).map((p) => p.id) as [string, ...string[]];

/** The rule sections: after the workflow (0), before the scripts section. A coding agent needs all of them, not a slice. */
const SCRIPTS_SECTION = skill.sections.find((s) => s.title.startsWith('The plugin scripts'))!;
const RULE_SECTIONS = skill.sections.filter((s) => s.number > 0 && s.number < SCRIPTS_SECTION.number);

function guidanceFor(playbook: Playbook, flow: { direction: string; currency: string }, extraSections: number[] = []) {
  const focus = [...new Set([1, ...playbook.sections, ...extraSections])].sort((a, b) => a - b);
  return {
    flow: playbook.route ? playbook.id : null,
    title: playbook.title,
    route: playbook.route,
    steps: playbook.steps.map((s, i) => ({ order: i + 1, ...s })),
    traps: playbook.traps,
    smallest_live_test: `${playbook.smallest_live_test} GlobalStack has no test mode: every call with a real key moves real money. Before it, pass every fault of the local failure sandbox (the globalstack-testing skill).`,
    code_rules: skill.checklist.map(({ rule, section }) => ({ rule, section })),
    skill: {
      name: SKILL_NAME,
      read_first: 'Read every section before writing code. focus_sections matter most for this flow; the others still apply. reference holds the formats, fields and tables this flow needs.',
      focus_sections: focus,
      sections: RULE_SECTIONS.map((s) => ({ section: s.number, title: s.title, text: s.text })),
      reference: referenceFor(skill, flow).map(({ title, text }) => ({ title, text })),
    },
  };
}

function matchFlow(direction: string, currency: string, network?: string): Playbook {
  const match = skill.playbooks.find(
    (p) => p.route && p.route.direction === direction && p.route.currency === currency && (!network || p.route.network === network),
  );
  return match ?? GENERAL;
}

const direction = z.enum(['onramp', 'offramp', 'conversion', 'transfer']).describe('onramp: collect local money into USDC. offramp: pay out USDC as local money. conversion: convert between your own wallets. transfer: send USDC to an external crypto address.');

const INPUT_NEEDED = {
  ok: false,
  status: null,
  code: 'invalid_input',
  developer_message: 'Give a flow, or give direction and currency (plus country_code for an onramp or offramp).',
  next_steps: ['Ask the user: pay out or collect, which currency and country, bank or mobile money, and who the recipients are.', 'Call again with their answers.'],
  request_id: null,
};

export const buildGuidance = defineTool({
  name: 'build_guidance',
  title: 'Plan the build and get the playbook',
  description: [
    'Read-only. Run this first, before writing Global Stack code.',
    'Checks the route on the live account, then returns the playbook for the flow: the steps in order with the tool for each,',
    'the traps merchants hit, the rules the code must follow, the smallest live test, and the skill sections it rests on.',
    `Give a known flow (${FLOW_IDS.join(', ')}), or give direction and currency (plus country_code for onramps and offramps) for anything else, including conversions and transfers.`,
    'Ask the user first: pay out or collect, which currency and country, bank or mobile money, and who the recipients are.',
    'Call it again for each flow you build.',
  ].join(' '),
  group: 'read',
  calls: SETUP_CALLS,
  inputSchema: {
    flow: z.enum(FLOW_IDS).optional(),
    direction: direction.optional(),
    currency: currencyCode.optional(),
    country_code: countryCode.optional(),
    network: z.enum(['bank', 'mobile_money']).optional(),
    recipients: z.enum(['own', 'business', 'individual']).optional().describe('Who receives or pays. Drives KYC and name rules.'),
  },
  async run(args, api) {
    const known = args.flow ? PLAYBOOKS[args.flow]!.route : undefined;
    // Conversions and transfers have no country: the currency is enough.
    const needsCountry = args.direction === 'onramp' || args.direction === 'offramp';
    const target = known ?? (args.direction && args.currency && (args.country_code || !needsCountry)
      ? { direction: args.direction, currency: args.currency, country_code: args.country_code, network: args.network }
      : undefined);
    if (!target) return INPUT_NEEDED;
    const playbook = args.flow ? PLAYBOOKS[args.flow]! : matchFlow(target.direction, target.currency, target.network);
    const checks = await runSetupChecks(api, {
      currency: target.currency,
      country_code: target.country_code,
      direction: target.direction,
      webhook_categories: [target.direction],
    });
    const route = checks.find((c) => c.check === 'route');
    return {
      ok: true,
      can_build: route?.status === 'ok',
      setup: checks,
      // Customers, KYC and names (section 7) matter as soon as we know who the recipients are.
      ...guidanceFor(playbook, target, args.recipients ? [7] : []),
      next_step: route?.status === 'ok'
        ? `Copy the files in this skill's code/ folder into the app unchanged (in another language, port them: see code/README.md). Then follow the steps in order on top of them. Test the code against each fault of the local failure sandbox (globalstack-testing skill). Then run gs.mjs build_check_acceptance with ${playbook.route ? `{"flow":"${playbook.id}"}` : `{"flow":"general","direction":"${target.direction}","currency":"${target.currency}"${target.country_code ? `,"country_code":"${target.country_code}"` : ''}}`}.`
        : route?.next_step,
    };
  },
});

export const buildCheckAcceptance = defineTool({
  name: 'build_check_acceptance',
  title: 'Check the account and a finished build',
  description: [
    'Read-only. With no flow, checks the account: route, access requests, active webhooks, wallet balances, approval settings and whether this key can move money, each with one next step.',
    'Give currency, country_code and direction to check the account for one corridor.',
    'With a flow, also checks a finished build against the Global Stack list for that flow: the script checks the live account itself',
    '(route open, an active webhook for the flow, a funded wallet), reads which failure sandbox faults this folder ran with no warnings,',
    'and returns the code rules with result not_checked. For a corridor with no playbook, give flow general with direction and currency (and country_code for onramps and offramps).',
    'Read the merchant code for each rule, mark it pass or fail, and show the user what is missing. Run it from the app\'s folder.',
  ].join(' '),
  group: 'read',
  calls: SETUP_CALLS,
  inputSchema: {
    flow: z.enum([...FLOW_IDS, 'general']).optional(),
    currency: currencyCode.optional(),
    country_code: countryCode.optional(),
    direction: direction.optional(),
  },
  async run({ flow, ...corridor }, api) {
    if (!flow) {
      const checks = await runSetupChecks(api, corridor);
      const worst = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status !== 'ok') ? 'warn' : 'ok';
      return { ok: true, result: worst, checks };
    }
    const needsCountry = corridor.direction === 'onramp' || corridor.direction === 'offramp';
    const route = flow === 'general'
      ? corridor.direction && corridor.currency && (corridor.country_code || !needsCountry) ? corridor : undefined
      : PLAYBOOKS[flow]!.route!;
    if (!route) {
      return { ...INPUT_NEEDED, developer_message: 'flow general needs direction and currency, plus country_code for an onramp or offramp.' };
    }
    const setup = await runSetupChecks(api, {
      currency: route.currency,
      country_code: route.country_code,
      direction: route.direction,
      webhook_categories: [route.direction!],
    });
    const account = setup
      // The agent's key and pending access requests are about the account, not this build.
      .filter((c) => c.check !== 'access_requests' && c.check !== 'api_key')
      .map((c) => ({
        rule: c.check,
        source: 'account' as const,
        result: c.status === 'ok' ? 'pass' : c.status === 'unknown' ? 'not_checked' : 'fail',
        detail: c.detail,
        fix: c.next_step,
      }));
    const coverage = faultCoverage(readRuns(), route.direction, (route as { network?: string }).network);
    const notPassed = coverage.filter((c) => c.status !== 'no_warnings');
    const sandbox = {
      rule: 'Run every fault of the local failure sandbox that applies to this flow, with no warnings, and check the app\'s own records after each run',
      source: 'sandbox' as const,
      result: notPassed.length === 0 ? 'pass' : coverage.some((c) => c.status === 'warnings') ? 'fail' : 'not_checked',
      detail: coverage.map((c) => `${c.fault}: ${c.status}${c.status === 'warnings' ? ` (${c.warnings})` : ''}`).join('; '),
      fix: notPassed.length
        ? `For each of ${notPassed.map((c) => c.fault).join(', ')}: run the globalstack-testing skill's sandbox.mjs start with that --fault, from this folder, drive the flow until the fault happens, and run sandbox.mjs report until it has no warnings. Then check the report's check_in_app items in the app's database.`
        : 'No warnings at the API is not proof on its own: confirm each report\'s check_in_app items in the app\'s database.',
    };
    const copies = referenceCopies();
    const behind = copies.filter((c) => c.status !== 'current');
    const reference = {
      rule: "The app's copies of the reference code match this plugin's code/ folder",
      source: 'reference_code' as const,
      result: copies.length === 0 ? 'not_checked' : behind.length ? 'fail' : 'pass',
      detail: copies.length
        ? copies.map((c) => `${c.path}: ${c.status}`).join('; ')
        : 'No copy of code/ under this folder: the app is in another language, or the files are not copied yet.',
      fix: behind.length
        ? `Replace ${behind.map((c) => c.path).join(', ')} with the same files from this skill's code/ folder: they differ from this plugin's version (a fix since they were copied, or an edit). Keep the import extensions the app needs.`
        : copies.length ? undefined : 'In another language, compare each ported file with code/ by hand after each plugin update.',
    };
    const code = skill.checklist.map((r) => ({
      rule: r.rule,
      source: 'code' as const,
      result: 'not_checked' as const,
      how_to_check: r.how_to_check,
      section: r.section,
    }));
    return {
      ok: true,
      flow,
      account_ready: account.every((a) => a.result === 'pass'),
      sandbox_passed: sandbox.result === 'pass',
      items: [...account, sandbox, reference, ...code],
      next_step: [
        'Check each code rule in the merchant code. Report each one as pass or fail, with one fix for each fail.',
        sandbox.result === 'pass' ? '' : 'Then run the sandbox faults listed under the sandbox item before the smallest live test.',
      ].filter(Boolean).join(' '),
    };
  },
});

export const guidanceTools = [buildGuidance, buildCheckAcceptance];
