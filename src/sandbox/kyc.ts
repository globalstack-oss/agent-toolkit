// Customer verification (KYC) sessions, the verdicts the grader drives, and the kyc.* webhooks.
// Behaviour follows the live API. The API source lines and spec sections behind each rule are cited in this file at
// commit 5ea09fa (plugin 0.2.1); shipped code no longer names them.
import { ApiError, badRequest, newId, notFound } from './core.ts';
import type { GlobalStack } from './api.ts';
import type { SimHttp } from './http.ts';

type SessionStatus = 'not_started' | 'in_progress' | 'pending' | 'completed' | 'failed';

export interface KycSession {
  id: string;
  customerId: string;
  status: SessionStatus;
  tierRequested: 'tier_1' | 'tier_2';
  tierAtCreation: string;
  provider: 'sumsub';
  hostedUrl: string;
  hostedUrlExpiresAt: string;
  redirectUrl: string | null;
  /** The public rejection code, or null. */
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The KYC provider's verification snapshot. Quote senders read it before the merchant profile. */
export interface VerificationSnapshot {
  provider: string;
  applicantId: string | null;
  type?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  country?: string;
  nationality?: string;
  companyName?: string;
  registrationNumber?: string;
  phone?: string;
  email?: string;
  idDocs?: Array<{ idDocType?: string; country?: string; number?: string; validUntil?: string }>;
  fetchedAt: string;
}

const TIER_RANK: Record<string, number> = { tier_0: 0, tier_1: 1, tier_2: 2 };
const OPEN: SessionStatus[] = ['not_started', 'in_progress', 'pending'];
/** Session status -> customer kyc_status. */
const CUSTOMER_STATUS: Record<SessionStatus, string> = { not_started: 'not_started', in_progress: 'in_progress', pending: 'pending', completed: 'approved', failed: 'rejected' };
const TTL_MS = 30 * 24 * 3600_000;

/** Public rejection codes and messages. Anything else reads as verification_failed. */
const REJECTIONS: Record<string, string> = {
  document_quality: 'The submitted document could not be read clearly. Please upload a clearer copy.',
  document_invalid: 'The submitted document is not valid or not accepted for verification.',
  identity_mismatch: 'The submitted details or selfie did not match the identity document.',
  additional_information_required: 'Additional information or documents are required to complete verification.',
  verification_unavailable: 'Verification could not be completed because a required check was unavailable.',
  duplicate: 'A verification already exists for this applicant.',
  not_eligible: 'The applicant is not eligible for verification.',
  business_verification_failed: 'The business could not be verified with the information provided.',
  verification_failed: 'Your verification could not be approved. Please contact support.',
};

const describe = (code: string | null) => (code === null ? null : { code: REJECTIONS[code] ? code : 'verification_failed', message: REJECTIONS[code] ?? REJECTIONS.verification_failed! });

const omitUndefined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The webhook `profile`: snake_case, id document numbers cut to their last 4. */
function maskProfile(v: VerificationSnapshot): Record<string, unknown> {
  return omitUndefined({
    type: v.type, first_name: v.firstName, last_name: v.lastName, dob: v.dob, country: v.country, nationality: v.nationality,
    company_name: v.companyName, registration_number: v.registrationNumber, phone: v.phone, email: v.email,
    id_docs: v.idDocs?.map((d) => omitUndefined({ id_doc_type: d.idDocType, country: d.country, number_last4: d.number ? d.number.slice(-4) : undefined, valid_until: d.validUntil })),
    fetched_at: v.fetchedAt,
  });
}

export class Kyc {
  readonly sessions = new Map<string, KycSession>();
  /** Verification snapshots by customer id; never exposed on the customer resource. */
  readonly verifications = new Map<string, VerificationSnapshot>();
  private readonly gs: GlobalStack;

  constructor(gs: GlobalStack) {
    this.gs = gs;
  }

  view(s: KycSession) {
    const c = this.gs.customers.get(s.customerId)!;
    const failure = describe(s.failureReason);
    return {
      id: s.id, customer_id: s.customerId, status: s.status, tier_requested: s.tierRequested, tier_current: c.tier,
      hosted_url: s.hostedUrl, hosted_url_expires_at: s.hostedUrlExpiresAt, redirect_url: s.redirectUrl,
      failure_reason: failure?.code ?? null, failure_reason_message: failure?.message ?? null, created_at: s.createdAt, updated_at: s.updatedAt,
    };
  }

  private customer(param: unknown): Record<string, any> {
    if (typeof param !== 'string' || !param.startsWith('cust_')) throw new ApiError(400, 'invalid_input', `customer_id must be a valid cust_… id (got '${String(param)}')`);
    const c = this.gs.customers.get(param);
    if (!c) throw notFound('Customer', param);
    return c;
  }

  latest(customerId: string): KycSession | undefined {
    return [...this.sessions.values()].filter((s) => s.customerId === customerId).at(-1);
  }

  /** POST /v1/customers/{id}/verifications. Does not touch the customer's kyc_status. */
  createSession(customerParam: unknown, body: any): KycSession {
    if (body.tier !== undefined && body.tier !== 'tier_1' && body.tier !== 'tier_2') throw badRequest('tier', 'tier must be one of tier_1, tier_2');
    if (body.redirect_url !== undefined && (typeof body.redirect_url !== 'string' || !/^https:\/\/[^\s/]+/.test(body.redirect_url))) throw badRequest('redirect_url', 'redirect_url must be a valid https:// URL');
    if (typeof body.redirect_url === 'string' && body.redirect_url.length > 2048) throw badRequest('redirect_url', 'redirect_url must be shorter than or equal to 2048 characters');
    const c = this.customer(customerParam);
    if (c.tier === 'tier_2') throw new ApiError(400, 'invalid_input', 'Customer is already at the highest tier');
    const tierRequested = body.tier ?? (c.tier === 'tier_0' ? 'tier_1' : 'tier_2');
    if (TIER_RANK[tierRequested]! <= TIER_RANK[c.tier]!) throw new ApiError(400, 'invalid_input', "tier must be higher than the customer's current tier");
    const now = this.gs.clock.now();
    const open = [...this.sessions.values()].find((s) => s.customerId === c.id && s.tierRequested === tierRequested && OPEN.includes(s.status));
    if (open && Date.parse(open.hostedUrlExpiresAt) > now) return open; // live link: returned as is
    const link = (id: string) => ({ hostedUrl: `https://in.sumsub.com/websdk/p/sbx_${id.slice(4).toLowerCase()}`, hostedUrlExpiresAt: this.gs.clock.iso(now + TTL_MS) });
    if (open) {
      Object.assign(open, link(open.id), { updatedAt: this.gs.clock.iso(now) }); // expired link refreshed in place
      return open;
    }
    const id = newId('kyc', now);
    const session: KycSession = {
      id, customerId: c.id, status: 'not_started', tierRequested, tierAtCreation: c.tier, provider: 'sumsub', ...link(id),
      redirectUrl: body.redirect_url ?? null, failureReason: null, createdAt: this.gs.clock.iso(now), updatedAt: this.gs.clock.iso(now),
    };
    this.sessions.set(id, session);
    return session;
  }

  register(http: SimHttp): void {
    const r = http.route.bind(http);
    r('POST', '/v1/customers/{id}/verifications', (req) => ({ data: this.view(this.createSession(req.params.id, req.body)), message: 'Verification session created' }), true);
    r('GET', '/v1/customers/{id}/verifications', (req) => {
      const c = this.customer(req.params.id);
      const s = this.latest(c.id);
      if (!s) {
        throw new ApiError(404, 'not_found', `KycSession 'customer ${c.id}' not found`, [`No verification session exists for this customer yet. Create one via POST /v1/customers/${c.id}/verifications.`]);
      }
      this.setKycStatus(c, CUSTOMER_STATUS[s.status]); // re-synced on every read
      return { data: this.view(s), message: 'Verification session fetched successfully' };
    });
    r('GET', '/v1/customers/{id}/limits', (req) => {
      const c = this.customer(req.params.id);
      if (c.id === this.gs.seed.defaultCustomerId) throw notFound('Customer', c.id);
      return { data: this.gs.payins.limits(c.id), message: 'Customer limits fetched successfully' };
    });
  }

  private setKycStatus(c: Record<string, any>, status: string): void {
    if (c.kyc_status === status) return;
    c.kyc_status = status;
    c.updated_at = this.gs.clock.iso();
  }

  // ── Grader controls: what the KYC provider reports ──
  /** The customer opened the link or submitted documents: session and customer `in_progress`, no webhook. */
  startVerification(customerId: string): Record<string, unknown> | null {
    const c = this.gs.customers.get(customerId);
    const s = c && this.latest(c.id);
    if (!c || !s || s.status === 'in_progress') return null;
    s.status = 'in_progress';
    s.failureReason = null;
    s.updatedAt = this.gs.clock.iso();
    this.setKycStatus(c, 'in_progress');
    return this.view(s);
  }

  /**
   * GREEN verdict on the latest session: session `completed`, customer `approved`, tier raised to the
   * session's tier (never lowered), the verification snapshot stored, `kyc.approved` emitted, then held deposits released.
   */
  approveVerification(customerId: string, snapshot: Partial<VerificationSnapshot> = {}): Record<string, unknown> | null {
    const c = this.gs.customers.get(customerId);
    const s = c && this.latest(c.id);
    if (!c || !s) return null; // no session: a no-op upstream
    const before = { tier: c.tier as string, kyc: c.kyc_status as string };
    const promote = TIER_RANK[s.tierRequested]! > TIER_RANK[c.tier]!;
    const verification = { ...this.defaultSnapshot(c), ...snapshot, fetchedAt: this.gs.clock.iso() };
    s.status = 'completed';
    s.failureReason = null;
    s.updatedAt = this.gs.clock.iso();
    if (promote) c.tier = s.tierRequested;
    this.setKycStatus(c, 'approved');
    c.updated_at = this.gs.clock.iso();
    this.verifications.set(c.id, verification);
    this.emitVerdict(c, s, true, before, promote, verification);
    if (promote) this.gs.payins.releaseAfterPromotion(c.id);
    return this.view(s);
  }

  /**
   * RED verdict on the latest session. `retry`: a resubmission request, session and customer `pending`, no webhook.
   * Otherwise final: session `failed`, customer `rejected`, `kyc.rejected` with the public reason.
   */
  rejectVerification(customerId: string, options: { reason?: string; retry?: boolean } = {}): Record<string, unknown> | null {
    const c = this.gs.customers.get(customerId);
    const s = c && this.latest(c.id);
    if (!c || !s) return null;
    const before = { tier: c.tier as string, kyc: c.kyc_status as string };
    s.updatedAt = this.gs.clock.iso();
    if (options.retry) {
      s.status = 'pending';
      s.failureReason = null;
      this.setKycStatus(c, 'pending');
      return this.view(s);
    }
    s.status = 'failed';
    s.failureReason = options.reason ?? 'verification_failed';
    this.setKycStatus(c, 'rejected');
    this.emitVerdict(c, s, false, before, false, null);
    return this.view(s);
  }

  /** kyc.approved / kyc.rejected: object id = session, status = verdict, changes from the old kyc_status. */
  private emitVerdict(c: Record<string, any>, s: KycSession, approved: boolean, before: { tier: string; kyc: string }, promoted: boolean, verification: VerificationSnapshot | null): void {
    const outcome = approved ? 'approved' : 'rejected';
    const failure = approved ? null : describe(s.failureReason);
    const object = {
      event_outcome: outcome,
      session_id: s.id,
      customer: omitUndefined({
        id: c.id, merchant_reference: c.merchant_reference, type: c.type, name: c.name, email: c.email, country_code: c.country_code,
        tier: c.tier, tier_upgraded_from: promoted ? before.tier : undefined, kyc_status: outcome,
      }),
      verification: omitUndefined({
        tier_requested: s.tierRequested, provider: s.provider,
        profile: approved && verification ? maskProfile(verification) : undefined,
        failure_reason: failure?.code, failure_reason_message: failure?.message,
      }),
      merchant_activation_triggered: false,
    };
    this.gs.events.emit(`kyc.${outcome}`, object, { status: [before.kyc, outcome] }, { objectId: s.id, status: outcome });
  }

  /** A plausible provider snapshot. Address never comes from verification, so quotes still need profile.address. */
  private defaultSnapshot(c: Record<string, any>): VerificationSnapshot {
    const now = this.gs.clock.iso();
    if (c.type === 'business') {
      return { provider: 'sumsub', applicantId: newId('app', Date.now()), type: 'company', companyName: c.name, registrationNumber: `RC-${c.id.slice(-7)}`, country: c.country_code, phone: c.profile?.phone ?? '+2348000000001', fetchedAt: now };
    }
    const [first, ...rest] = String(c.name).trim().split(/\s+/);
    return {
      provider: 'sumsub', applicantId: newId('app', Date.now()), type: 'individual', firstName: first, lastName: rest.join(' ') || first, dob: '1990-01-15',
      country: c.country_code, nationality: c.country_code, phone: c.profile?.phone ?? '+2348000000001',
      idDocs: [{ idDocType: 'PASSPORT', country: c.country_code, number: `A${c.id.slice(-8)}` }], fetchedAt: now,
    };
  }
}
