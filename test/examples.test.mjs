// The reference code, inside the two example apps, against every fault of the failure sandbox: the same
// sandbox.mjs a merchant's agent runs. Each fault must end with the payment final, the books right and a
// report with no warnings, and build_check_acceptance must then see every fault as passed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SANDBOX = join(ROOT, 'plugin/skills/globalstack-testing/scripts/sandbox.mjs');
const GS = join(ROOT, 'plugin/skills/globalstack-integration/scripts/gs.mjs');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXAMPLES = [
  {
    name: 'ngn-withdraw',
    flow: 'ngn_bank_withdraw',
    faults: ['none', 'lost_response', 'provider_error', 'rate_limit', 'webhook_silence', 'webhook_noise', 'slow_final'],
    owner: 'u_ada',
    other: 'u_tunde',
    start: { path: '/withdrawals', body: { amount: '50.00' } },
    otherBody: { amount: '40.00' },
    status: (id) => `/withdrawals/${id}`,
    // 152.384211 USDC, minus the 50.00 paid out once.
    books: (db) => assert.equal(db.prepare("SELECT usdc_balance FROM users WHERE id = 'u_ada'").get().usdc_balance, '102.384211'),
  },
  {
    name: 'xaf-topup',
    flow: 'xaf_momo_topup',
    faults: ['none', 'lost_response', 'provider_error', 'webhook_silence', 'webhook_noise', 'slow_final'],
    owner: 'u_marie',
    other: 'u_paul',
    start: { path: '/topups', body: { amount_xaf: '5000', phone: '+237670000001' } },
    otherBody: { amount_xaf: '6000' },
    status: (id) => `/topups/${id}`,
    // 10 USDC plus what GlobalStack says it delivered, credited once.
    books: (db, report) => {
      const credited = report.movements.filter((m) => m.kind === 'onramp' && m.status === 'success');
      assert.equal(credited.length, 1);
      const want = (10_000_000n + BigInt(Math.round(Number(credited[0].received_amount) * 1e6))).toString().padStart(7, '0');
      assert.equal(db.prepare("SELECT usdc_balance FROM users WHERE id = 'u_marie'").get().usdc_balance, `${want.slice(0, -6)}.${want.slice(-6)}`);
    },
  },
];

function freePort() {
  return new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const listening = (port) => new Promise((ok) => {
  const socket = connect(port, '127.0.0.1', () => { socket.destroy(); ok(true); }).on('error', () => ok(false));
});

async function until(what, check, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const json = (cmd, args, opts) => JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', ...opts }));

for (const ex of EXAMPLES) {
  describe(`example ${ex.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), `gs-${ex.name}-`));
    cpSync(join(ROOT, 'examples', ex.name), dir, { recursive: true, dereference: true });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const sandbox = (...args) => json(process.execPath, [SANDBOX, ...args], { cwd: dir });
    after(() => {
      try { sandbox('stop'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    // Starts the sandbox with `fault` and the app on a fresh database, runs `fn`, and stops the app.
    async function withApp(fault, fn) {
      const port = await freePort();
      const started = sandbox('start', '--app-port', String(port), '--fault', fault);
      assert.equal(started.ok, true);
      const dbPath = join(dir, `${fault}-${port}.db`);
      const env = { ...process.env, ...started.env, DATABASE_PATH: dbPath, GLOBALSTACK_POLL_MS: '1000' };
      // setup.ts prints a demo login token per user: "session for u_ada: <token>".
      const setupOut = execFileSync(TSX, ['src/setup.ts'], { cwd: dir, env, encoding: 'utf8' });
      const tokens = Object.fromEntries([...setupOut.matchAll(/^session for (\S+): (\S+)$/gm)].map((m) => [m[1], m[2]]));
      const as = (user) => ({ authorization: `Bearer ${tokens[user]}` });
      const app = spawn(TSX, ['src/server.ts'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let log = '';
      const keep = (chunk) => { log = (log + chunk).slice(-4000); };
      app.stdout.on('data', keep);
      app.stderr.on('data', keep);
      let exited = null;
      app.on('exit', (code, signal) => { exited = { code, signal }; });
      try {
        const base = `http://127.0.0.1:${port}`;
        await until('the app to listen', () => listening(port));
        const final = (id) => until(`${ex.name} ${id} to be final`, async () => {
          const r = await (await fetch(`${base}${ex.status(id)}`, { headers: as(ex.owner) })).json();
          return ['completed', 'failed', 'returned'].includes(r.status) && r.status;
        });
        await fn({ base, dbPath, final, as });
        assert.equal(exited, null, `the app exited during the test:\n${log.slice(-2000)}`);
      } finally {
        if (!exited) process.kill(-app.pid, 'SIGKILL');
      }
    }
    // As the owner unless `headers` says otherwise.
    const post = (base, body, headers) =>
      fetch(`${base}${ex.start.path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const checkBooks = async (dbPath) => {
      await sleep(1500); // late webhooks (duplicates, stale and forged events) reach the app
      const report = sandbox('report');
      assert.deepEqual(report.warnings, []);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        ex.books(db, report);
      } finally {
        db.close();
      }
    };

    for (const fault of ex.faults) {
      test(fault, () => withApp(fault, async ({ base, dbPath, final, as }) => {
        const res = await post(base, ex.start.body, as(ex.owner));
        assert.equal(res.status, 201, await res.clone().text());
        const { id } = await res.json();
        if (fault === 'slow_final') {
          await until('a movement in processing', () => sandbox('report').movements.some((m) => m.status === 'processing'));
          sandbox('advance', '--hours', '3');
        }
        assert.equal(await final(id), 'completed');
        await checkBooks(dbPath);
      }));
    }

    test('a request sent again with the same Idempotency-Key gets the first answer and pays once', () => withApp('none', async ({ base, dbPath, final, as }) => {
      const key = { ...as(ex.owner), 'idempotency-key': `retry-${ex.name}` };
      const first = await post(base, ex.start.body, key);
      assert.equal(first.status, 201, await first.clone().text());
      const { id } = await first.json();
      const again = await post(base, ex.start.body, key);
      assert.equal(again.status, 200, await again.clone().text());
      assert.equal((await again.json()).id, id);
      const other = await post(base, { ...ex.start.body, ...ex.otherBody }, key);
      assert.equal(other.status, 409, await other.clone().text());
      assert.equal((await post(base, ex.start.body, { ...as(ex.owner), 'idempotency-key': '' })).status, 400);
      assert.equal(await final(id), 'completed');
      await checkBooks(dbPath);
    }));

    test('the caller is the logged-in user, never the user_id in the body', () => withApp('none', async ({ base, as }) => {
      assert.equal((await post(base, ex.start.body, {})).status, 401);
      assert.equal((await post(base, ex.start.body, { authorization: 'Bearer not-a-session' })).status, 401);
      const res = await post(base, ex.start.body, as(ex.owner));
      assert.equal(res.status, 201, await res.clone().text());
      const { id } = await res.json();
      const get = (headers) => fetch(`${base}${ex.status(id)}`, { headers });
      assert.equal((await get({})).status, 401);
      assert.equal((await get(as(ex.other))).status, 404);
      assert.equal((await get(as(ex.owner))).status, 200);
      // Another user naming the owner in the body, with the owner's Idempotency-Key, starts a payment of their own,
      // which the owner cannot see.
      const key = 'same-key-two-users';
      assert.equal((await post(base, ex.start.body, { ...as(ex.owner), 'idempotency-key': key })).status, 201);
      const other = await post(base, { ...ex.start.body, user_id: ex.owner }, { ...as(ex.other), 'idempotency-key': key });
      assert.equal(other.status, 201, await other.clone().text());
      const otherId = (await other.json()).id;
      assert.equal((await fetch(`${base}${ex.status(otherId)}`, { headers: as(ex.owner) })).status, 404);
      assert.equal((await fetch(`${base}${ex.status(otherId)}`, { headers: as(ex.other) })).status, 200);
    }));

    test('build_check_acceptance sees every fault passed', () => {
      // The running sandbox answers the account checks; the faults come from this folder's sandbox runs.
      const { base_url, secret_key } = sandbox('start', '--app-port', '1', '--fault', 'none');
      const out = json(process.execPath, [GS, 'build_check_acceptance', JSON.stringify({ flow: ex.flow })], {
        cwd: dir,
        env: { ...process.env, GLOBALSTACK_API_KEY: secret_key, GLOBALSTACK_API_BASE_URL: base_url, GLOBALSTACK_NO_UPDATE_CHECK: '1' },
      });
      const item = out.items.find((i) => i.source === 'sandbox');
      assert.equal(item.result, 'pass', item.detail);
      assert.equal(out.sandbox_passed, true);
    });
  });
}
