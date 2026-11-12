// Feature 2: customer KYC that moves over time, kyc.* webhooks, and what tier_0 changes before KYC.
// Run with the plugin's tests (test/sim-flows.test.ts).
import { EVAL_IDS } from '../../src/sandbox/sim.ts';
import { check, done, setup } from './helpers.ts';

const { sim, call, received, subscribe, waitFor, close } = await setup();
await subscribe(['kyc', 'deposit']);
const kycEvents = () => received.filter((e) => e.event_category === 'kyc');
const customer = async (id: string) => (await call('GET', `/v1/customers/${id}`)).json.data;

const created = await call('POST', '/v1/customers', { type: 'individual', name: 'Ada Obi', email: 'ada@eval.test', country_code: 'NG' });
const ada = created.json.data;
check('new customer is tier_0, not_started', ada.tier === 'tier_0' && ada.kyc_status === 'not_started', ada);

// Before any session
const none = await call('GET', `/v1/customers/${ada.id}/verifications`);
check('no session yet: 404 with next steps', none.status === 404 && none.json.meta.next_steps.action.includes(`POST /v1/customers/${ada.id}/verifications`), none.json);
check('bad tier is bad_request', (await call('POST', `/v1/customers/${ada.id}/verifications`, { tier: 'tier_3' })).json.code === 'bad_request');
check('bad customer prefix', (await call('POST', '/v1/customers/abc/verifications', {})).json.code === 'invalid_input');

// tier_0 rules
const fiat = await call('POST', '/v1/wallets', { currency: 'NGN', customer_id: ada.id });
check('fiat wallet needs an approved customer', fiat.status === 409 && fiat.json.code === 'invalid_status' && fiat.json.message === "Customer must be approved to create a fiat wallet (current status: 'not_started')", fiat.json);
const usdc = (await call('POST', '/v1/wallets', { currency: 'USDC', customer_id: ada.id })).json.data;
check('crypto wallet is fine at tier_0', /^wal_/.test(usdc.id));
const limits0 = (await call('GET', `/v1/customers/${ada.id}/limits`)).json.data;
check('tier_0 limits are the merchant pool', limits0.applies_to === 'merchant_pool' && limits0.tier === 'tier_0' && limits0.cap_usd === null && limits0.enforced === true, limits0);
const quote0 = await call('POST', '/v1/onramps/quotes', { wallet_id: usdc.id, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: '1000' });
// The default customer is the merchant's own business, created with the merchant's phone at registration, so it can
// be the sender of a tier_0 customer's quote.
check('tier_0 quote uses the default customer as sender', quote0.status === 200 && quote0.json.message === 'Quote created successfully', quote0.json);

// Session
const s1 = await call('POST', `/v1/customers/${ada.id}/verifications`, {}, 'verify-ada-1');
const session = s1.json.data;
check('session created', s1.json.message === 'Verification session created' && /^kyc_/.test(session.id) && session.status === 'not_started' && session.tier_requested === 'tier_1' && session.tier_current === 'tier_0', session);
check('link valid 30 days', Date.parse(session.hosted_url_expires_at) - Date.parse(session.created_at) === 30 * 24 * 3600_000);
check('open session reused', (await call('POST', `/v1/customers/${ada.id}/verifications`, {})).json.data.id === session.id);
check('creating a session leaves kyc_status alone', (await customer(ada.id)).kyc_status === 'not_started');

sim.gs.startVerification(ada.id);
check('engagement: in_progress', (await customer(ada.id)).kyc_status === 'in_progress');
sim.gs.rejectVerification(ada.id, { retry: true, reason: 'document_quality' });
const retry = (await call('GET', `/v1/customers/${ada.id}/verifications`)).json.data;
check('RED+RETRY: pending, no reason', retry.status === 'pending' && retry.failure_reason === null && (await customer(ada.id)).kyc_status === 'pending', retry);
await sim.events.drain();
check('no webhook before a final verdict', kycEvents().length === 0);

sim.gs.approveVerification(ada.id);
await waitFor('kyc.approved', () => kycEvents().length === 1);
const approved = kycEvents()[0];
check('kyc.approved envelope', approved.event_type === 'kyc.approved' && approved.event_object_id === session.id && approved.event_object_status === 'approved' && JSON.stringify(approved.event_object_changes) === '{"status":["pending","approved"]}', approved);
const obj = approved.event_object;
check('kyc.approved object', obj.event_outcome === 'approved' && obj.session_id === session.id && obj.customer.tier === 'tier_1' && obj.customer.tier_upgraded_from === 'tier_0' && obj.customer.kyc_status === 'approved' && obj.verification.provider === 'sumsub' && obj.merchant_activation_triggered === false, obj);
check('id document masked', obj.verification.profile.id_docs[0].number_last4.length === 4 && !('number' in obj.verification.profile.id_docs[0]), obj.verification.profile);
const after = await customer(ada.id);
check('customer approved at tier_1', after.tier === 'tier_1' && after.kyc_status === 'approved', after);
check('session completed', (await call('GET', `/v1/customers/${ada.id}/verifications`)).json.data.status === 'completed');

// After KYC
const quote1 = await call('POST', '/v1/onramps/quotes', { wallet_id: usdc.id, source_currency: 'ZAR', country_code: 'ZA', source_network: 'bank', source_amount: '1000' });
check('tier_1 quote: own identity, verification gives phone/dob/id, address still needed', quote1.status === 400 && quote1.json.message === `customer '${ada.id}' must have an address to create a quote`, quote1.json.message);
const limits1 = (await call('GET', `/v1/customers/${ada.id}/limits`)).json.data;
check('tier_1 limits are its own', limits1.applies_to === 'self' && limits1.tier === 'tier_1' && limits1.cap_usd === '1000000', limits1);
check('fiat wallet allowed once approved', (await call('POST', '/v1/wallets', { currency: 'NGN', customer_id: ada.id })).status === 200);

// Tier upgrade releases the customer's own held deposits
sim.behaviour = { tierCapsUsd: { tier_1: '50', tier_2: '1000' } };
const cred = (await call('POST', `/v1/wallets/${usdc.id}/credentials`, { network: 'base' })).json.data;
sim.gs.simulateDeposit(cred.details.address, '40', { flow: 'direct' });
const heldId = sim.gs.simulateDeposit(cred.details.address, '30', { flow: 'direct' });
await waitFor('deposit.held', () => received.some((e) => e.event_type === 'deposit.held'));
check('second deposit over the tier_1 cap is held', (await call('GET', `/v1/transactions/${heldId}`)).json.data.status === 'received');
await call('POST', `/v1/customers/${ada.id}/verifications`, { tier: 'tier_2' });
sim.gs.approveVerification(ada.id);
await waitFor('release', () => received.filter((e) => e.event_type === 'deposit.confirmed').length === 2);
const w = (await call('GET', `/v1/wallets/${usdc.id}`)).json.data;
check('tier_2 promotion released the hold', w.available_balance === '70.000000' && w.pending_balance === '0.000000', w);
check('second session gets its own kyc.approved', kycEvents().length === 2 && kycEvents()[1].event_object.customer.tier_upgraded_from === 'tier_1');
check('tier_2 cannot verify again', (await call('POST', `/v1/customers/${ada.id}/verifications`, {})).json.message === 'Customer is already at the highest tier');

// Final rejection
const bo = (await call('POST', '/v1/customers', { type: 'individual', name: 'Bo Lee', email: 'bo@eval.test', country_code: 'NG' })).json.data;
await call('POST', `/v1/customers/${bo.id}/verifications`, {});
sim.gs.rejectVerification(bo.id, { reason: 'identity_mismatch' });
await waitFor('kyc.rejected', () => kycEvents().some((e) => e.event_type === 'kyc.rejected'));
const rej = kycEvents().find((e) => e.event_type === 'kyc.rejected');
check('kyc.rejected', rej.event_object_status === 'rejected' && rej.event_object.verification.failure_reason === 'identity_mismatch' && rej.event_object.customer.tier === 'tier_0' && !('tier_upgraded_from' in rej.event_object.customer) && JSON.stringify(rej.event_object_changes) === '{"status":["not_started","rejected"]}', rej);
const boSession = (await call('GET', `/v1/customers/${bo.id}/verifications`)).json.data;
check('rejected session carries the public reason', boSession.status === 'failed' && boSession.failure_reason === 'identity_mismatch' && boSession.failure_reason_message.startsWith('The submitted details'), boSession);
check('customer rejected', (await customer(bo.id)).kyc_status === 'rejected');

await close();
done();
