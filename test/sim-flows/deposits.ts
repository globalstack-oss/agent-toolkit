// Feature 1: USDC deposits to a credential or deposit address, with the real lifecycle and webhooks.
// Run with the plugin's tests (test/sim-flows.test.ts).
import { EVAL_IDS } from '../../src/sandbox/sim.ts';
import { check, done, setup } from './helpers.ts';

const { sim, call, received, subscribe, waitFor, close } = await setup();
await subscribe(['deposit']);
const USDC = EVAL_IDS.usdcWalletId;
const wallet = async () => (await call('GET', `/v1/wallets/${USDC}`)).json.data;
const events = (type: string) => received.filter((e) => e.event_type === type);

// Credentials
const cred = await call('POST', `/v1/wallets/${USDC}/credentials`, { network: 'base', label: 'Inbound' }, 'cred-key-0001');
check('POST credential 200', cred.status === 200 && cred.json.message === 'Wallet credential created successfully', cred.json);
const c = cred.json.data;
check('credential shape', /^wcr_/.test(c.id) && c.type === 'crypto' && c.currency === 'USDC' && c.network === 'base' && c.status === 'active' && c.wallet.id === USDC, c);
check('credential address', /^0x[0-9a-f]{40}$/.test(c.details.address) && c.details.chain === 'base' && c.details.currency === 'usdc', c.details);
const replay = await call('POST', `/v1/wallets/${USDC}/credentials`, { network: 'base', label: 'Inbound' }, 'cred-key-0001');
check('idempotent replay returns the same credential', replay.json.data.id === c.id);
check('bad network is bad_request', (await call('POST', `/v1/wallets/${USDC}/credentials`, { network: 'tron' })).json.code === 'bad_request');
const ngnCred = await call('POST', `/v1/wallets/${EVAL_IDS.ngnWalletId}/credentials`, { network: 'base' });
check('network not on the currency', ngnCred.status === 400 && ngnCred.json.message === "network 'base' is not supported by currency NGN", ngnCred.json.message);
const list = await call('GET', `/v1/wallets/${USDC}/credentials`);
check('list credentials', list.json.data[0].id === c.id && list.json.meta.total === 1, list.json.meta);
check('get credential', (await call('GET', `/v1/wallets/${USDC}/credentials/${c.id}`)).json.data.id === c.id);
check('get credential wrong prefix', (await call('GET', `/v1/wallets/${USDC}/credentials/crd_X`)).json.code === 'invalid_input');
check('wallet lists credentials', (await wallet()).credentials.length === 1);

// Deposit addresses
const da = await call('POST', `/v1/wallets/${USDC}/deposit-addresses`, { network: 'solana' });
check('POST deposit address', da.status === 200 && /^da_/.test(da.json.data.id) && da.json.data.details.address.length >= 32 && !('network' in da.json.data), da.json);
const daFiat = await call('POST', `/v1/wallets/${EVAL_IDS.ngnWalletId}/deposit-addresses`, { network: 'base' });
check('deposit address on a fiat wallet is refused', daFiat.status === 400, daFiat.json.message);
check('list deposit addresses by status', (await call('GET', `/v1/wallets/${USDC}/deposit-addresses?status=active`)).json.data.length === 1);
check('bad status filter', (await call('GET', `/v1/wallets/${USDC}/deposit-addresses?status=nope`)).json.code === 'invalid_input');

// 1. Received then confirmed: pending balance first, then available.
const start = await wallet();
const t1 = sim.gs.simulateDeposit(c.details.address, '25.5');
const mid = await wallet();
check('received: pending balance', mid.pending_balance === '25.500000' && mid.available_balance === start.available_balance, mid);
await waitFor('deposit.confirmed', () => events('deposit.confirmed').length === 1);
const after = await wallet();
check('confirmed: available balance', after.available_balance === '10025.500000' && after.pending_balance === '0.000000', after);
const rec = events('deposit.received')[0];
check('deposit.received envelope', rec?.event_object_status === 'received' && rec.event_category === 'deposit' && rec.event_object_changes === null && rec.event_object_id === t1 && rec.event_object.status === 'processing' && !!rec.event_object.deposit_timestamp, rec);
const conf = events('deposit.confirmed')[0];
check('deposit.confirmed envelope', conf?.event_object_status === 'confirmed' && conf.event_object.status === 'success' && conf.event_object.confirmed_at !== null, conf?.event_object);
const row = (await call('GET', `/v1/transactions/${t1}`)).json.data;
check('transaction row', row.type === 'deposit' && row.status === 'success' && row.source_type === 'credential' && row.source_id === c.id && row.reference.startsWith('dep-') && row.root_transaction_id === t1 && row.metadata.to_address === c.details.address && !('deposit_timestamp' in row), row);
const deps = await call('GET', '/v1/transactions?type=deposit');
check('listed with type=deposit (a walk-in deposit is a root)', deps.json.data.some((x: any) => x.id === t1));

// 2. Over the tier cap: held, then released.
sim.behaviour = { tierCapsUsd: { tier_1: '1000000', tier_2: '100' } };
const t2 = sim.gs.simulateDeposit(c.id, '80');
await waitFor('deposit.held', () => events('deposit.held').length === 1);
const held = (await call('GET', `/v1/transactions/${t2}`)).json.data;
check('held row', held.status === 'received' && held.metadata.hold_reason === 'tier_limit' && held.confirmed_at === null, held);
check('held amount sits in pending', (await wallet()).pending_balance === '80.000000');
check('deposit.held envelope', events('deposit.held')[0].event_object_status === 'held');
sim.gs.releaseHeldDeposit(t2);
await waitFor('second deposit.confirmed', () => events('deposit.confirmed').length === 2);
const released = (await call('GET', `/v1/transactions/${t2}`)).json.data;
check('released row', released.status === 'success' && !('hold_reason' in released.metadata), released);
check('released to available', (await wallet()).available_balance === '10105.500000');
check('release event dated at the row', events('deposit.confirmed')[1].event_created_at === held.created_at);
sim.behaviour = { tierCapsUsd: { tier_1: '1000000', tier_2: '1000000' } };

// 3. A voided hold: the completed event fails the deposit.
const t3 = sim.gs.simulateDeposit(da.json.data.details.address, '10', { flow: 'manual' });
sim.gs.voidDepositHold(t3);
sim.gs.confirmDeposit(t3);
await waitFor('deposit.failed', () => events('deposit.failed').length === 1);
const failed = (await call('GET', `/v1/transactions/${t3}`)).json.data;
check('failed row', failed.status === 'failed' && failed.metadata.failure_reason === 'hold_voided' && failed.source_type === 'deposit_address', failed);
check('no credit from a voided hold', (await wallet()).available_balance === '10105.500000' && (await wallet()).pending_balance === '0.000000');

// 4. A disabled credential: deposits are held, and there is no tier release for them.
const del = await call('DELETE', `/v1/wallets/${USDC}/credentials/${c.id}`);
check('deactivate', del.json.data.success === true && del.json.message === 'Wallet credential has been successfully deactivated', del.json);
check('deactivate twice is 409', (await call('DELETE', `/v1/wallets/${USDC}/credentials/${c.id}`)).json.code === 'invalid_status');
const t4 = sim.gs.simulateDeposit(c.details.address, '5', { flow: 'direct' });
await waitFor('deposit.held for disabled', () => events('deposit.held').length === 2);
check('direct flow sends no deposit.received', events('deposit.received').length === 3);
check('held for the disabled pay-in', (await call('GET', `/v1/transactions/${t4}`)).json.data.metadata.hold_reason === 'payin_disabled');
let threw = false;
try {
  sim.gs.releaseHeldDeposit(t4);
} catch {
  threw = true;
}
check('no tier release for a pay-in hold', threw);

// 5. An onramp quote mints a solana credential on a wallet that has none active of its own.
const fresh = await call('POST', '/v1/wallets', { currency: 'USDC', customer_id: EVAL_IDS.treasuryCustomerId, label: 'Fresh' });
await call('POST', '/v1/onramps/quotes', { wallet_id: fresh.json.data.id, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: '1000' });
const minted = (await call('GET', `/v1/wallets/${fresh.json.data.id}/credentials`)).json.data;
check('quote mints a solana credential', minted.length === 1 && minted[0].network === 'solana' && minted[0].label === 'Fresh', minted);

await close();
done();
