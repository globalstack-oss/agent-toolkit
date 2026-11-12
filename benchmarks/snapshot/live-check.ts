// A 15-minute check that the simulator's three write rules match the real API. No money moves:
// the execute runs against an EMPTY wallet, so GlobalStack refuses it with 422 and stores a failed row.
//
//   GLOBALSTACK_API_KEY=... EMPTY_WALLET_ID=wal_... BENEFICIARY_ID=ben_... \
//     node --experimental-strip-types benchmarks/snapshot/live-check.ts
//
// EMPTY_WALLET_ID: a USDC wallet with a zero balance. BENEFICIARY_ID: an NGN bank beneficiary of the
// same customer. Side effect to know about: each quote opens a provider conversion that simply expires.
const BASE = process.env.GLOBALSTACK_API_BASE_URL ?? 'https://api.globalstack.io';
const KEY = process.env.GLOBALSTACK_API_KEY;
const WALLET = process.env.EMPTY_WALLET_ID;
const BEN = process.env.BENEFICIARY_ID;
if (!KEY || !WALLET || !BEN) {
  console.error('Set GLOBALSTACK_API_KEY, EMPTY_WALLET_ID and BENEFICIARY_ID.');
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, code: json.code, data: json.data, message: json.message };
}

const wallet = await call('GET', `/v1/wallets/${WALLET}`);
if (wallet.data?.available_balance !== undefined && Number(wallet.data.available_balance) !== 0) {
  console.error(`Stopping: ${WALLET} is not empty (${wallet.data.available_balance}). Use an empty wallet so nothing can be paid.`);
  process.exit(1);
}

const stamp = Date.now();
const results: Array<[string, string, string]> = [];
const expect = (rule: string, want: string, got: string) => results.push([rule, want, got]);

// 1. A quote replayed with the same key and byte-identical body returns the same quote.
const key = `evalcheck-quote-${stamp}`;
const body = { wallet_id: WALLET, beneficiary_id: BEN, source_amount: '5.00' };
const q1 = await call('POST', '/v1/offramps/quotes', body, key);
const q2 = await call('POST', '/v1/offramps/quotes', body, key);
expect('Idempotent replay returns the stored quote', 'same quote id', q1.data?.id && q1.data.id === q2.data?.id ? 'same quote id' : `${q1.status}/${q2.status} ${q1.data?.id} vs ${q2.data?.id}`);

// 2. Execute from the empty wallet: 422, and the failed row keeps the quote and the reference.
const ref = `evalcheck-${stamp}`;
const e1 = await call('POST', '/v1/offramps', { quote_id: q1.data?.id, reference: ref });
expect('Short balance at execute', '422 ledger_insufficient_funds', `${e1.status} ${e1.code}`);

// 3. The same quote again: used up by the failed execute.
const e2 = await call('POST', '/v1/offramps', { quote_id: q1.data?.id, reference: `${ref}-b` });
expect('A failed execute uses up the quote', '409 duplicate_resource', `${e2.status} ${e2.code}`);

// 4. A new quote with the failed attempt's reference: the reference is taken.
const q3 = await call('POST', '/v1/offramps/quotes', body);
const e3 = await call('POST', '/v1/offramps', { quote_id: q3.data?.id, reference: ref });
expect('A failed movement keeps its reference', '409 duplicate_resource', `${e3.status} ${e3.code}`);

for (const [rule, want, got] of results) console.log(`${want === got ? 'MATCH' : 'DIFF '}  ${rule}: expected ${want}, got ${got}`);
