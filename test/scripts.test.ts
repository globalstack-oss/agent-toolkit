// The read-only script's guarantees that do not need the API: it answers doc questions without network access.
// Run with: node --import tsx --test test/scripts.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GlobalStackClient, type ScopedClient } from '../src/api/client';
import { checkForUpdate } from '../src/cli/update-check';
import { parseSkill, referenceFor } from '../src/skill';
import { runSetupChecks } from '../src/tools/check-setup';
import { referenceCopies } from '../src/tools/reference-copies';
import { createSearchDocs } from '../src/tools/search-docs';

const ROOT = resolve(import.meta.dirname, '..');
const CODE = join(ROOT, 'plugin/skills/globalstack-integration/code');
const COPY = join(ROOT, 'plugin/skills/globalstack-integration/docs/llms-full.txt');
const GS = join(ROOT, 'plugin/skills/globalstack-integration/scripts/gs.mjs');
const SKILL = join(ROOT, 'plugin/skills/globalstack-integration');
const skillFile = (name: string) => readFileSync(join(SKILL, name), 'utf8');

test('without network, search_docs answers from the copy in the plugin and says so', async () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const answer = (await createSearchDocs(offline, COPY).run({ query: 'create beneficiary label crypto address' }, null as never)) as any;
  assert.equal(answer.ok, true);
  assert.match(answer.docs_copy, /could not be reached \(fetch failed\).*copy in this plugin, taken (on or before )?\d{4}-\d{2}-\d{2}\./);
  assert.equal(answer.results[0].title, 'Create a beneficiary');
  assert.match(answer.results[0].text, /`label` — required/);
});

test('with network, search_docs answers from the live docs', async () => {
  const live = (async () => new Response('# Live page\nSource: https://docs.globalstack.io/live\n\nlabel and beneficiary')) as unknown as typeof fetch;
  const answer = (await createSearchDocs(live, COPY).run({ query: 'beneficiary label' }, null as never)) as any;
  assert.equal(answer.docs_copy, undefined);
  assert.equal(answer.results[0].title, 'Live page');
});

test('a long page that names every field does not outrank the page a query is about', async () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const docs = createSearchDocs(offline, COPY);
  const top = async (query: string) => ((await docs.run({ query }, null as never)) as any).results[0].title;
  // Webhook events shows every payload, so it names nearly every field. It came first for 55 of 103 queries that
  // agents sent in the eval builds, until the ranking weighed each match by the page's length.
  assert.equal(await top('create offramp quote request body wallet_id beneficiary_id source_amount narration'), 'Create an offramp quote');
  assert.equal(await top('providers for country bank code response'), 'List network providers');
  assert.equal(await top('webhook event payload event_category event_object offramp.success'), 'Webhook events');
});

test('search_docs returns a page whole by its path, and a cut search hit says how to get it', async () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const docs = createSearchDocs(offline, COPY);
  const hit = (await docs.run({ query: 'error reference' }, null as never)) as any;
  const errors = hit.results.find((r: any) => r.title === 'Error reference');
  assert.match(errors.text, /\[cut: search_docs '\{"page":"\/errors"\}' returns the whole page\]$/);
  for (const page of ['/errors', 'https://docs.globalstack.io/errors#authentication_failed', 'errors.md']) {
    const whole = (await docs.run({ page }, null as never)) as any;
    assert.equal(whole.page, '/errors');
    assert.match(whole.docs_copy, /copy in this plugin/);
    assert.equal(whole.results.length, 1);
    assert.ok(whole.results[0].text.length > 4000 && !whole.results[0].text.includes('[cut:'));
  }
  const missing = (await docs.run({ page: '/nope' }, null as never)) as any;
  assert.deepEqual(missing.results, []);
  assert.match(missing.hint, /No page has this path/);
  assert.equal(((await docs.run({}, null as never)) as any).code, 'invalid_input');
  assert.equal(((await docs.run({ query: 'errors', page: '/errors' }, null as never)) as any).code, 'invalid_input');
});

test('the script names the plugin and its version in the User-Agent', async () => {
  const agents: Array<string | undefined> = [];
  const api = createServer((req, res) => {
    agents.push(req.headers['user-agent']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: true, message: 'ok', data: [], meta: {} }));
  });
  await new Promise<void>((listening) => api.listen(0, '127.0.0.1', listening));
  try {
    const { port } = api.address() as AddressInfo;
    const env = { ...process.env, GLOBALSTACK_API_KEY: 'gsa_sk_test_x', GLOBALSTACK_API_BASE_URL: `http://127.0.0.1:${port}`, GLOBALSTACK_NO_UPDATE_CHECK: '1' };
    const { stdout } = await promisify(execFile)(process.execPath, [GS, 'get_wallet', '{}'], { env });
    assert.equal(JSON.parse(stdout).ok, true);
    const { version } = JSON.parse(readFileSync(join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    assert.deepEqual(agents, [`globalstack-plugin/${version}`]);
  } finally {
    api.close();
  }
});

test('the API key goes only to an https base URL, or http to this machine', async () => {
  const tryBase = async (baseUrl: string) => {
    const sent: string[] = [];
    const recording = (async (url: URL) => {
      sent.push(url.href);
      return new Response(JSON.stringify({ status: true, message: 'ok', data: {}, meta: {} }));
    }) as unknown as typeof fetch;
    const client = new GlobalStackClient({ apiKey: 'gsa_sk_test_x', baseUrl, fetch: recording });
    return { sent, result: await client.scoped([{ method: 'GET', path: '/v1/wallet' }]).request('GET', '/v1/wallet') };
  };
  for (const base of ['http://example.com', 'http://127.0.0.1.example.com', 'https://user:pass@api.globalstack.io', 'not a url']) {
    const { sent, result } = await tryBase(base);
    assert.deepEqual(sent, [], base);
    assert.equal(result.ok, false, base);
    assert.equal((result as any).code, 'unsafe_base_url', base);
    assert.match((result as any).developer_message, /GLOBALSTACK_API_BASE_URL/, base);
  }
  for (const base of ['https://api.globalstack.io', 'http://127.0.0.1:4010', 'http://localhost:4010', 'http://[::1]:4010']) {
    const { sent, result } = await tryBase(base);
    assert.equal(sent.length, 1, base);
    assert.equal(result.ok, true, base);
  }
});

test('SKILL.md fits in what Claude Code brings back after a compaction', () => {
  // Claude Code 2.1.304 re-attaches an invoked skill's first 5,000 tokens, counted as 4 characters each, after a
  // "Base directory for this skill: <path>" line. 160 characters leave room for a long install path.
  const body = skillFile('SKILL.md').replace(/^---\n[\s\S]*?\n---\n/, '');
  const content = `Base directory for this skill: ${'x'.repeat(160)}\n\n${body}`;
  assert.ok(Math.round(content.length / 4) <= 5000, `SKILL.md has ${body.length} characters: move lookup material to reference.md`);
});

test('build_guidance gives a flow the reference topics for its direction and currency', () => {
  const skill = parseSkill({ skill: skillFile('SKILL.md'), checklist: skillFile('checklist.md'), playbooks: skillFile('playbooks.md'), reference: skillFile('reference.md') });
  const titles = (direction: string, currency: string) => referenceFor(skill, { direction, currency }).map((t) => t.title);
  const everyFlow = ['Failure reasons', 'Webhook amounts', 'Currency access', 'KYC', 'Crypto deposit addresses'];
  assert.deepEqual(titles('offramp', 'ZAR'), [...everyFlow, 'Payout account checks', 'ZAR payout accounts']);
  assert.deepEqual(titles('offramp', 'NGN'), [...everyFlow, 'Payout account checks']);
  assert.deepEqual(titles('onramp', 'ZAR'), [...everyFlow, 'Onramp deposit instructions']);
  assert.deepEqual(titles('transfer', 'USDC'), everyFlow);
  // Each topic SKILL.md names by title exists.
  for (const [, title] of skillFile('SKILL.md').matchAll(/`reference\.md`, ([^)]+)\)/g)) {
    assert.ok(skill.reference.some((t) => t.title === title), title);
  }
});

test('the acceptance check finds app copies of the reference code that differ from this plugin\'s', () => {
  const app = mkdtempSync(join(tmpdir(), 'gs-app-'));
  try {
    mkdirSync(join(app, 'src/globalstack'), { recursive: true });
    mkdirSync(join(app, 'node_modules/x'), { recursive: true });
    cpSync(join(CODE, 'payments.ts'), join(app, 'src/globalstack/payments.ts'));
    // The one allowed edit: extensions on relative imports (NodeNext).
    writeFileSync(join(app, 'src/globalstack/webhooks.ts'), readFileSync(join(CODE, 'webhooks.ts'), 'utf8').replace(/from '\.\/(gs|types)'/g, "from './$1.js'"));
    // A copy from before a fix.
    writeFileSync(join(app, 'src/globalstack/gs.ts'), readFileSync(join(CODE, 'gs.ts'), 'utf8').replace('const fields', 'const oldFields'));
    cpSync(join(CODE, 'money.ts'), join(app, 'node_modules/x/money.ts')); // dependencies are not the app's copies
    assert.deepEqual(referenceCopies(app, CODE), [
      { path: 'src/globalstack/gs.ts', file: 'gs.ts', status: 'outdated' },
      { path: 'src/globalstack/payments.ts', file: 'payments.ts', status: 'current' },
      { path: 'src/globalstack/webhooks.ts', file: 'webhooks.ts', status: 'current' },
    ]);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('every file in code/ names its license, so the copies merchants make keep it', () => {
  for (const file of readdirSync(CODE).filter((f) => f.endsWith('.ts'))) {
    const head = readFileSync(join(CODE, file), 'utf8').split('\n').slice(0, 8);
    assert.ok(head.includes('// SPDX-License-Identifier: MIT') && head.includes('// Copyright (c) 2026 Global Stack'), file);
  }
});

test('no shipped file names internal code: API source files or spec sections', () => {
  // Everything under plugin/ is public. The docs copy is the public docs as they are.
  const internal = /[\w.-]+\.ts:\d|\b[\w-]+\.(?:service|controller|repository|handler|middleware|activities|guard|entity|dto|config|response)\.ts\b|§/;
  const files = readdirSync(join(ROOT, 'plugin'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== COPY);
  assert.ok(files.length > 10);
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!internal.test(line), `${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
});

test('the account check warns when the agent\'s key can move money, and passes a Viewer key', async () => {
  // GET /v1/me: effective_role is the lower of the key's role and its owner's membership.
  const account = (role: string) =>
    ({
      request: async (_method: string, path: string) =>
        path === '/v1/me'
          ? { ok: true, status: 200, meta: null, data: { auth_method: 'api_key', effective_role: role, api_key: { id: 'key_1', label: 'agent', role } } }
          : { ok: true, status: 200, meta: null, data: [] },
    }) as unknown as ScopedClient;
  const keyCheck = async (role: string) => (await runSetupChecks(account(role))).find((c) => c.check === 'api_key')!;
  const developer = await keyCheck('consumer_developer');
  assert.equal(developer.status, 'warn');
  assert.match(developer.next_step!, /Viewer role/);
  const viewer = await keyCheck('consumer_viewer');
  assert.equal(viewer.status, 'ok');
  assert.equal(viewer.next_step, undefined);
});

test('a run says when a newer plugin is out, with the update command for how it was installed', async () => {
  const release = { version: '0.2.1', repository: 'example/toolkit', latest: 'https://example.test/main/plugin.json' };
  const asked: string[] = [];
  const serving = (body: unknown, status = 200) =>
    (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const script = (dir: string) => `${dir}/skills/globalstack-integration/scripts/gs.mjs`;
  const claude = script('/Users/ada/.claude/plugins/cache/globalstack/globalstack/0.2.1');
  const newer = await checkForUpdate(release, claude, { fetch: serving({ version: '0.10.0' }), env: {} });
  assert.equal(newer?.latest, '0.10.0'); // numbers, not text: 0.10.0 is after 0.2.1
  assert.deepEqual(asked, ['https://example.test/main/plugin.json']);
  assert.match(newer!.how_to_update, /claude plugin marketplace update globalstack`, then `claude plugin update globalstack@globalstack/);
  const how = async (path: string) => (await checkForUpdate(release, path, { fetch: serving({ version: '0.3.0' }), env: {} }))!.how_to_update;
  assert.match(await how(script('/home/ada/.codex/plugins/cache/globalstack/globalstack/0.2.1')), /codex plugin marketplace upgrade globalstack/);
  assert.match(await how('C:\\Users\\ada\\.claude\\plugins\\cache\\globalstack\\globalstack\\0.2.1\\skills\\globalstack-integration\\scripts\\gs.mjs'), /claude plugin update/);
  assert.match(await how(script('/home/ada/.cursor/plugins/cache/gs-plugin/globalstack/3f2a9c1')), /npx skills add example\/toolkit --skill '\*' -a cursor --copy -y/);
  assert.match(await how('/home/ada/shop/.agents/skills/globalstack-integration/scripts/gs.mjs'), /npx skills update -y/);
  assert.match(await how(script('/home/ada/gs-plugin/plugin')), /\/plugin marketplace add example\/toolkit`.*codex plugin marketplace add example\/toolkit/);

  // The same or an older version, an unreadable answer and a failed request add nothing.
  for (const answer of [serving({ version: '0.2.1' }), serving({ version: '0.1.9' }), serving({ version: 'next' }), serving(null), serving({ version: '9.0.0' }, 404)]) {
    assert.equal(await checkForUpdate(release, claude, { fetch: answer, env: {} }), null);
  }
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate(release, claude, { fetch: offline, env: {} }), null);
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await checkForUpdate(release, claude, { fetch: hanging, env: {}, timeoutMs: 50 }), null);
  assert.ok(Date.now() - started < 1000, 'a slow network must not hold the check up');

  // The opt-out sends no request at all.
  let requests = 0;
  const counting = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ version: '0.3.0' }));
  }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate(release, claude, { fetch: counting, env: { GLOBALSTACK_NO_UPDATE_CHECK: '1' } }), null);
  assert.equal(requests, 0);
});
