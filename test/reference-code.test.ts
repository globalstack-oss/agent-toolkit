// The reference code's own guarantees, run against the sandbox's simulator: the ones a merchant's books depend on
// that the example apps do not reach. Run with: node --import tsx --test test/reference-code.test.ts
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Webhook } from 'svix';
import { ensureBeneficiary, payeeReference } from '../plugin/skills/globalstack-integration/code/beneficiaries';
import { configureGlobalStack, gs, GsError, onGlobalStackAlert } from '../plugin/skills/globalstack-integration/code/gs';
import { parseAmount } from '../plugin/skills/globalstack-integration/code/money';
import { createPayments } from '../plugin/skills/globalstack-integration/code/payments';
import { type Db, sqliteDb } from '../plugin/skills/globalstack-integration/code/types';
import { ensureWebhook, webhookReceiver } from '../plugin/skills/globalstack-integration/code/webhooks';
import { EVAL_IDS, Sim } from '../src/sandbox/sim';

const ROOT = resolve(import.meta.dirname, '..');
const CODE = join(ROOT, 'plugin/skills/globalstack-integration/code');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.env.GLOBALSTACK_CATALOG = join(ROOT, 'plugin/skills/globalstack-testing/catalog.json');
const sim = new Sim({ secretKey: 'gsa_sk_test_reference_code' });
const alerts: string[] = [];
before(async () => {
  configureGlobalStack({ secretKey: 'gsa_sk_test_reference_code', baseUrl: await sim.listen(0) });
  onGlobalStackAlert((message) => alerts.push(message));
});
after(() => sim.close());

const memoryDb = () => {
  const handle = new DatabaseSync(':memory:');
  return { handle, db: sqliteDb(handle) };
};

describe('parseAmount', () => {
  test('trailing zeros do not count as decimals', () => {
    assert.equal(parseAmount('12.500', 2), '12.50');
    assert.equal(parseAmount('12.505', 2), null);
    assert.equal(parseAmount('0.00', 2), null);
  });
  test('a long run of zeros is parsed in linear time', () => {
    const started = Date.now();
    assert.equal(parseAmount(`1.${'0'.repeat(200_000)}1`, 2), null);
    assert.ok(Date.now() - started < 1000);
  });
});

describe('base URL', () => {
  // Swaps in a fetch that records where the key would go, and puts the simulator back afterwards.
  const tryBase = async (baseUrl: string) => {
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      sent.push(String(url));
      return new Response(JSON.stringify({ status: true, message: 'ok', data: {}, meta: {} }));
    }) as typeof fetch;
    configureGlobalStack({ baseUrl });
    try {
      await gs('GET', '/v1/wallet');
      return { sent, error: null };
    } catch (error) {
      return { sent, error: error as Error };
    } finally {
      globalThis.fetch = realFetch;
      configureGlobalStack({ baseUrl: sim.url });
    }
  };
  test('http to another host, a URL with a user name, or no URL at all: refused before the key is sent', async () => {
    for (const base of ['http://example.com', 'https://user:pass@api.globalstack.io', 'ftp://127.0.0.1', 'not a url']) {
      const { sent, error } = await tryBase(base);
      assert.deepEqual(sent, [], base);
      assert.match(error?.message ?? '', /GLOBALSTACK_BASE_URL.*must be https/, base);
    }
  });
  test('https, and http to localhost, 127.0.0.1 or ::1, are used', async () => {
    for (const base of ['https://api.globalstack.io', 'http://127.0.0.1:4010', 'http://localhost:4010/', 'http://[::1]:4010']) {
      const { sent, error } = await tryBase(base);
      assert.equal(error, null, base);
      assert.equal(sent.length, 1, base);
    }
  });
});

describe('beneficiaries', () => {
  test('changed payout details get a new beneficiary; a reused reference with other details throws', async () => {
    const [provider] = await gs<any[]>('GET', '/v1/countries/NG/providers?network=bank');
    const body = (account: string) => ({
      type: 'fiat', name: 'Ada Obi', label: 'payout', currency: 'NGN', country_code: 'NG', network: 'bank',
      provider_id: provider.id, account_number: account, customer_id: EVAL_IDS.treasuryCustomerId,
    });
    const first = body('0123456789');
    const corrected = body('0987654321');
    assert.notEqual(payeeReference('u_ada', first), payeeReference('u_ada', corrected));
    const id = await ensureBeneficiary({ ...first, merchant_reference: payeeReference('u_ada', first) });
    // The same details again (a retry after a lost response): 409, found, same id.
    assert.equal(await ensureBeneficiary({ ...first, merchant_reference: payeeReference('u_ada', first) }), id);
    const other = await ensureBeneficiary({ ...corrected, merchant_reference: payeeReference('u_ada', corrected) });
    assert.notEqual(other, id);
    // An app that keeps one reference per user and changes the details: refused, never the old account.
    await assert.rejects(ensureBeneficiary({ ...corrected, merchant_reference: payeeReference('u_ada', first) }), /pays other details/);
  });

  test('a refused body names every refused field, in the error and in the log', async () => {
    const [provider] = await gs<any[]>('GET', '/v1/countries/NG/providers?network=bank');
    const logged: string[] = [];
    const log = console.error;
    console.error = (line: string) => logged.push(line);
    try {
      const body = { type: 'fiat', currency: 'NGN', country_code: 'NG', network: 'bank', provider_id: provider.id, account_number: '0123456789', customer_id: EVAL_IDS.treasuryCustomerId };
      await assert.rejects(gs('POST', '/v1/beneficiaries', { body: JSON.stringify(body) }), (err: GsError) => {
        assert.deepEqual(err.fields.map((f) => f.field), ['name', 'label']);
        assert.match(err.message, /name: name should not be empty; label: label should not be empty/);
        return true;
      });
    } finally {
      console.error = log;
    }
    assert.match(logged.join('\n'), /-> 400 bad_request request_id=\S+ .*name: name should not be empty/);
  });
});

describe('sqliteDb', () => {
  test('a db query inside a transaction throws instead of waiting forever', async () => {
    const { db } = memoryDb();
    await db.exec('CREATE TABLE t (x INTEGER)');
    await assert.rejects(db.transaction(async () => db.get('SELECT 1 AS one')), /Use the `tx`/);
    assert.equal((await db.get('SELECT 1 AS one'))?.one, 1); // the lock was released
  });

  test('the raw handle throws while a transaction is open, instead of joining it', async () => {
    const { handle, db } = memoryDb();
    await db.exec('CREATE TABLE t (x INTEGER)');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const open = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
      await gate;
      throw new Error('rolled back');
    });
    await sleep(10);
    assert.throws(() => handle.prepare('INSERT INTO t VALUES (2)').run(), /raw SQLite handle/);
    release();
    await assert.rejects(open, /rolled back/);
    handle.prepare('INSERT INTO t VALUES (3)').run(); // fine again once it is closed
    assert.deepEqual((await db.all('SELECT x FROM t')).map((r) => r.x), [3]);
  });
});

/** A signed delivery, the way GlobalStack sends it. */
function delivery(secret: string, event: Record<string, unknown>, svixId = `msg_${Math.random().toString(36).slice(2)}`) {
  const raw = JSON.stringify(event);
  const at = new Date();
  return {
    raw,
    headers: { 'svix-id': svixId, 'svix-timestamp': String(Math.floor(at.getTime() / 1000)), 'svix-signature': new Webhook(secret).sign(svixId, at, raw) },
  };
}

async function receiverWith(svixModule: 'svix' | 'svix-v2', onEvent: (event: any) => Promise<void> | void) {
  let receiver: typeof webhookReceiver = webhookReceiver;
  if (svixModule === 'svix-v2') {
    // The same file, importing svix 2.x, whose verify() returns nothing.
    const dir = mkdtempSync(join(ROOT, '.tmp-svix2-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    for (const f of readdirSync(CODE).filter((n) => n.endsWith('.ts'))) cpSync(join(CODE, f), join(dir, f));
    writeFileSync(join(dir, 'webhooks.ts'), readFileSync(join(dir, 'webhooks.ts'), 'utf8').replace("from 'svix'", "from 'svix-v2'"));
    receiver = (await import(join(dir, 'webhooks.ts'))).webhookReceiver;
  }
  const { db } = memoryDb();
  const secret = `whsec_${Buffer.from('reference-code-test-secret-0123456789').toString('base64')}`;
  await db.exec('CREATE TABLE IF NOT EXISTS gs_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.run("INSERT INTO gs_settings (key, value) VALUES ('webhook_secret', ?)", secret);
  return { receive: receiver(db, onEvent), secret };
}

for (const svixModule of ['svix', 'svix-v2'] as const) {
  describe(`webhookReceiver with ${svixModule === 'svix' ? 'svix 1.x' : 'svix 2.x'}`, () => {
    test('verifies, parses and processes each event once', async () => {
      const seen: any[] = [];
      const { receive, secret } = await receiverWith(svixModule, (event) => void seen.push(event));
      const event = { event_id: 'evt_1', event_category: 'offramp', event_object: { id: 'ofr_1', status: 'success' } };
      const d = delivery(secret, event);
      assert.deepEqual(await receive(d.raw, d.headers), { status: 200, body: { ok: true } });
      assert.deepEqual(seen, [event]);
      const again = delivery(secret, event); // a duplicate: another message id, the same event_id
      assert.equal((await receive(again.raw, again.headers)).status, 200);
      assert.equal(seen.length, 1);
      const forged = delivery(`whsec_${Buffer.from('not-the-secret-0123456789012345678').toString('base64')}`, { ...event, event_id: 'evt_2' });
      assert.equal((await receive(forged.raw, forged.headers)).status, 400);
      const headers = new Headers(d.headers); // Fetch API headers (Next.js, Hono) work too
      assert.equal((await receive(Buffer.from(d.raw), headers)).status, 200);
    });

    test('an event that failed is processed again on redelivery; one in progress answers 409', async () => {
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { receive, secret } = await receiverWith(svixModule, async (event) => {
        calls++;
        if (event.event_id === 'evt_fail' && calls === 1) throw new Error('database down');
        if (event.event_id === 'evt_slow') await gate;
      });
      const failing = delivery(secret, { event_id: 'evt_fail', event_category: 'kyc' });
      assert.equal((await receive(failing.raw, failing.headers)).status, 500);
      assert.equal((await receive(failing.raw, failing.headers)).status, 200);
      assert.equal(calls, 2);
      const slow = delivery(secret, { event_id: 'evt_slow', event_category: 'kyc' });
      const first = receive(slow.raw, slow.headers);
      await sleep(20);
      assert.equal((await receive(slow.raw, slow.headers)).status, 409);
      release();
      assert.equal((await first).status, 200);
    });
  });
}

describe('ensureWebhook', () => {
  test('a URL GlobalStack would refuse registers nothing, warns, and lets setup finish', async () => {
    const { db } = memoryDb();
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warned.push(line);
    const before = sim.http.log.length;
    try {
      assert.equal(await ensureWebhook(db, 'http://localhost:3000/webhooks/globalstack', ['offramp']), null);
      assert.equal(await ensureWebhook(db, 'https://localhost:3000/webhooks/globalstack', ['offramp']), null);
    } finally {
      console.warn = warn;
    }
    assert.equal(sim.http.log.length, before); // no call to GlobalStack
    assert.equal(warned.length, 2);
    assert.match(warned[0]!, /not registered.*pollers/);
    assert.match(await ensureWebhook(db, 'https://merchant.example.com/webhooks/globalstack', ['offramp']) ?? '', /^whr_/);
  });
});

describe('payments', () => {
  const conversionEngine = (db: Db, books: string[]) =>
    createPayments(db, {
      kind: 'conversion',
      prepare: async () => {
        const q = await gs<any>('POST', '/v1/conversions/quotes', {
          body: JSON.stringify({ source_wallet_id: EVAL_IDS.usdcWalletId, destination_wallet_id: EVAL_IDS.ngnWalletId, source_amount: '10.00' }),
          retry: true,
        });
        return { quote_id: q.id };
      },
      onCompleted: (p) => void books.push(`completed ${p.id}`),
      onFailed: (p, reason) => void books.push(`refunded ${p.id} ${reason}`),
      onSettled: (p) => void books.push(`settled ${p.id} ${p.status}`),
    });

  test('a conversion returned before we saw its success is settled as completed, never refunded', async () => {
    const { db } = memoryDb();
    const books: string[] = [];
    const conversions = conversionEngine(db, books);
    await db.transaction((tx) => conversions.create(tx, 'cv_returned_1', { user_id: 'u1' }));
    await conversions.drive('cv_returned_1'); // sent; GlobalStack answers processing
    const m = [...sim.gs.movements.values()].find((x) => x.reference === 'cv_returned_1-1');
    assert.ok(m, 'the conversion reached GlobalStack');
    // Success, then returned, while our app was not looking (no webhook endpoint, no poller).
    await until(() => m.status === 'success');
    sim.gs.returnMovement(m.id);
    const before = alerts.length;
    await conversions.drive('cv_returned_1');
    const p = (await conversions.get('cv_returned_1'))!;
    assert.equal(p.status, 'completed');
    assert.equal(p.failure_reason, 'returned');
    assert.deepEqual(books, ['completed cv_returned_1', 'settled cv_returned_1 completed']);
    const raised = () => alerts.slice(before).filter((a) => a.includes('cv_returned_1')).length;
    assert.equal(raised(), 1);
    // Seen again (a webhook, the returns sweep): no second alert, no refund.
    await conversions.onEvent({ event_category: 'conversion', event_object: { id: m.id, reference: m.reference, status: 'returned' } });
    assert.equal(raised(), 1);
    assert.deepEqual(books, ['completed cv_returned_1', 'settled cv_returned_1 completed']);
  });

  test('the returns sweep finds a payout returned long after it was created, and refunds the user once', async () => {
    const { db } = memoryDb();
    const books: string[] = [];
    const [provider] = await gs<any[]>('GET', '/v1/countries/NG/providers?network=bank');
    const ben = await gs<any>('POST', '/v1/beneficiaries', {
      body: JSON.stringify({ type: 'fiat', name: 'Ngozi Okafor', label: 'payout', currency: 'NGN', country_code: 'NG', network: 'bank', provider_id: provider.id, account_number: '2233445566', customer_id: EVAL_IDS.treasuryCustomerId }),
    });
    const payouts = createPayments(db, {
      kind: 'offramp',
      prepare: async () => {
        const q = await gs<any>('POST', '/v1/offramps/quotes', {
          body: JSON.stringify({ wallet_id: EVAL_IDS.usdcWalletId, beneficiary_id: ben.id, source_amount: '10.00' }),
          retry: true,
        });
        return { quote_id: q.id };
      },
      onCompleted: (p) => void books.push(`completed ${p.id}`),
      onFailed: (p, reason) => void books.push(`refunded ${p.id} ${reason}`),
    });
    await db.transaction((tx) => payouts.create(tx, 'po_late_return', { user_id: 'u1' }));
    await payouts.drive('po_late_return');
    const m = [...sim.gs.movements.values()].find((x) => x.reference === 'po_late_return-1');
    assert.ok(m, 'the payout reached GlobalStack');
    await until(() => m.status === 'success');
    await payouts.drive('po_late_return');
    assert.deepEqual(books, ['completed po_late_return']);
    // The payout was created 40 days ago, and comes back now. Its webhook is lost: only the sweep can see it.
    m.created_at = new Date(Date.now() - 40 * 86_400_000).toISOString();
    sim.gs.returnMovement(m.id);
    await payouts.reconcile(); // the first pass sweeps for returns
    assert.deepEqual(books, ['completed po_late_return', 'refunded po_late_return returned']);
    await payouts.onEvent({ event_category: 'offramp', event_object: { id: m.id, reference: m.reference, status: 'returned' } });
    assert.deepEqual(books, ['completed po_late_return', 'refunded po_late_return returned']);
  });

  test('a transfer engine never asks for returned transfers (the API answers 400)', async () => {
    const { db } = memoryDb();
    const transfers = createPayments(db, { kind: 'transfer', prepare: async () => ({}) });
    const from = sim.http.log.length;
    await transfers.reconcile();
    assert.equal(sim.http.log.slice(from).filter((r) => r.path.startsWith('/v1/transfers')).length, 0);
    await assert.rejects(gs('GET', '/v1/transfers?status=returned'), /status must be one of/);
  });

  test('ids that cannot become an Idempotency-Key are refused before anything is saved', async () => {
    const { db } = memoryDb();
    const payouts = createPayments(db, { kind: 'offramp', prepare: async () => ({}) });
    await assert.rejects(db.transaction((tx) => payouts.create(tx, 'user@example.com', {})), /letters, digits/);
    await assert.rejects(db.transaction((tx) => payouts.create(tx, '42', {})), /letters, digits/);
  });
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}
