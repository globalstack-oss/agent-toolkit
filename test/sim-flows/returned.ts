// Feature 3: a successful offramp, conversion or onramp is returned later, with the real ledger effect.
// Run with the plugin's tests (test/sim-flows.test.ts).
import { EVAL_IDS } from '../../src/sandbox/sim.ts';
import { check, done, setup } from './helpers.ts';

const { sim, call, received, subscribe, waitFor, close } = await setup();
await subscribe(['offramp', 'conversion', 'onramp', 'deposit']);
const USDC = EVAL_IDS.usdcWalletId;
const usdc = async () => (await call('GET', `/v1/wallets/${USDC}`)).json.data;
const event = (type: string) => received.find((e) => e.event_type === type);
const status = async (kind: string, id: string) => (await call('GET', `/v1/${kind}s/${id}`)).json.data;

// Offramp: success, then returned -> source amount credited back as an offramp_reversal deposit.
const providers = await call('GET', '/v1/countries/NG/providers?network=bank');
const gtb = providers.json.data.find((p: any) => p.code === '058');
const ben = (await call('POST', '/v1/beneficiaries', { type: 'fiat', name: 'Ada', label: 'u1', currency: 'NGN', country_code: 'NG', provider_id: gtb.id, network: 'bank', account_number: '0123456789', customer_id: EVAL_IDS.treasuryCustomerId })).json.data;
const q = (await call('POST', '/v1/offramps/quotes', { wallet_id: USDC, beneficiary_id: ben.id, source_amount: '50.00' })).json.data;
const ofr = (await call('POST', '/v1/offramps', { quote_id: q.id, reference: 'ret-1' })).json.data;
await waitFor('offramp success', () => !!event('offramp.success'));
check('offramp debited', (await usdc()).available_balance === '9950.000000');
let threw = false;
try {
  sim.gs.returnMovement('ofr_nope');
} catch {
  threw = true;
}
check('unknown id throws', threw);
const reversalId = sim.gs.returnMovement(ofr.id)!;
await waitFor('offramp.returned', () => !!event('offramp.returned'));
const o = await status('offramp', ofr.id);
check('offramp returned', o.status === 'returned' && o.failure_reason === 'returned' && o.failure_reason_message === 'This transaction was returned; any funds debited for it have been released.' && o.received_amount === o.destination_amount, o);
check('source amount credited back', (await usdc()).available_balance === '10000.000000');
const ret = event('offramp.returned');
check('offramp.returned envelope', ret.event_object_status === 'returned' && JSON.stringify(ret.event_object_changes) === '{"status":["success","returned"]}' && ret.event_object.terminal_at !== null && ret.event_object.actual_destination_amount === o.destination_amount, ret);
const rev = (await call('GET', `/v1/transactions/${reversalId}`)).json.data;
const parent = `txn_${ofr.id.slice(4)}`;
check('reversal row', rev.type === 'deposit' && rev.source_type === 'offramp_reversal' && rev.status === 'confirmed' && rev.source_id === ofr.id && rev.reference === `${ofr.id}_reversal` && rev.source_amount === '50.000000' && rev.to_wallet_id === USDC && rev.parent_transaction_id === parent, rev);
check('reversal is a child: not in the roots list', !(await call('GET', '/v1/transactions?type=deposit')).json.data.some((x: any) => x.id === reversalId));
check('reversal shows with include_related', (await call('GET', '/v1/transactions?type=deposit&include_related=true')).json.data.some((x: any) => x.id === reversalId));
check('reversal under the offramp transaction', (await call('GET', `/v1/transactions/${parent}`)).json.data.related_transactions.some((x: any) => x.id === reversalId));
await sim.events.drain();
check('no deposit webhook for the reversal', !received.some((e) => e.event_category === 'deposit'));
threw = false;
try {
  sim.gs.returnMovement(ofr.id);
} catch {
  threw = true;
}
check('only a successful movement can be returned', threw);

// Conversion (USDC -> NGN): returned, no credit.
const cq = (await call('POST', '/v1/conversions/quotes', { source_wallet_id: USDC, destination_wallet_id: EVAL_IDS.ngnWalletId, source_amount: '10.00' })).json.data;
const con = (await call('POST', '/v1/conversions', { quote_id: cq.id, reference: 'ret-con-1' })).json.data;
await waitFor('conversion success', () => !!event('conversion.success'));
const beforeCon = await usdc();
sim.gs.returnMovement(con.id);
await waitFor('conversion.returned', () => !!event('conversion.returned'));
check('conversion returned', (await status('conversion', con.id)).status === 'returned');
check('conversion: no credit', (await usdc()).available_balance === beforeCon.available_balance && beforeCon.available_balance === '9990.000000');

// Conversion (NGN -> USDC, fiat source): the row goes returned, but the webhook never goes out (M§12.3).
const fq = (await call('POST', '/v1/conversions/quotes', { source_wallet_id: EVAL_IDS.ngnWalletId, destination_wallet_id: USDC, source_amount: '5000.00' })).json.data;
const fcon = (await call('POST', '/v1/conversions', { quote_id: fq.id, reference: 'ret-con-2' })).json.data;
await waitFor('fiat conversion success', () => received.filter((e) => e.event_type === 'conversion.success').length === 2);
sim.gs.returnMovement(fcon.id);
await sim.events.drain();
check('fiat-source conversion returned without a webhook', (await status('conversion', fcon.id)).status === 'returned' && received.filter((e) => e.event_type === 'conversion.returned').length === 1);
const beforeCon2 = await usdc();

// Onramp (ZAR bank): returned, no ledger effect.
const oq = (await call('POST', '/v1/onramps/quotes', { wallet_id: USDC, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: '1000' })).json.data;
const onr = (await call('POST', '/v1/onramps', { quote_id: oq.id })).json.data;
sim.gs.payDeposit(onr.id);
await waitFor('onramp success', () => !!event('onramp.success') && !!event('deposit.confirmed'));
const beforeOnr = await usdc();
check('onramp credited the USDC through a child deposit', beforeOnr.available_balance === (Number(beforeCon2.available_balance) + Number(oq.destination_amount)).toFixed(6), beforeOnr);
const dep = event('deposit.confirmed').event_object;
check('onramp deposit is a child of the onramp', dep.parent_transaction_id === `txn_${onr.id.slice(4)}` && dep.source_type === 'credential' && event('deposit.confirmed').event_object_status === 'confirmed', dep);
sim.gs.returnMovement(onr.id);
await waitFor('onramp.returned', () => !!event('onramp.returned'));
check('onramp returned', (await status('onramp', onr.id)).status === 'returned');
check('onramp: no ledger effect', (await usdc()).available_balance === beforeOnr.available_balance);

await close();
done();
