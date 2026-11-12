// Webhook endpoints and event delivery, signed the Svix way.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { newId, type Clock } from './core.ts';

export type Category = 'onramp' | 'offramp' | 'conversion' | 'transfer' | 'deposit' | 'kyc';
export const CATEGORIES: Category[] = ['onramp', 'offramp', 'conversion', 'transfer', 'deposit', 'kyc'];

export interface Endpoint {
  id: string;
  url: string;
  event_categories: Category[];
  active: boolean;
  secret: string;
  created_at: string;
  updated_at: string;
}

export interface SimEvent {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

/**
 * Envelope fields that do not come from the resource itself. Deposits: the status is the outcome
 * (`received`, `held`, `confirmed`, `failed`), not the row status, and `event_created_at` is the
 * deposit time. KYC: the object id is the `kyc_` session and the
 * status is `approved` / `rejected`.
 */
export interface EnvelopeOverrides {
  objectId?: string;
  status?: string;
  occurredAt?: string;
}

export interface Delivery {
  eventId: string;
  type: string;
  endpointId: string;
  attempt: number;
  status: number;
  forged: boolean;
  at: string;
}

/**
 * How events reach the app in this scenario.
 * - normal: each event once, in order, retried on non-2xx
 * - silent: nothing is delivered (the app must poll)
 * - noisy: every event twice, a stale event after the final one, and one forged event the app must reject
 */
export type DeliveryMode = 'normal' | 'silent' | 'noisy';

/** Assumed schedule: 7 attempts, x5 backoff from 1 s. */
const RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 125_000, 625_000, 3_125_000];

/** evt_<uuid v5 of "<resource_id>:<topic>">: one id per resource per topic, the same on every retry. */
function eventId(resourceId: string, topic: string): string {
  const h = createHash('sha1').update('6ba7b811-9dad-11d1-80b4-00c04fd430c8').update(`${resourceId}:${topic}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `evt_${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class Events {
  readonly endpoints = new Map<string, Endpoint>();
  readonly events: SimEvent[] = [];
  readonly deliveries: Delivery[] = [];
  mode: DeliveryMode = 'normal';
  /** Builds the forged event for noisy mode: same shape as a real one, wrong signature. */
  forge: ((real: SimEvent) => SimEvent | null) | null = null;
  private forgedOnce = false;
  private readonly clock: Clock;
  private readonly developerId: string;
  private readonly publicUrl: { from: string; to: string } | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(clock: Clock, developerId: string, publicUrl?: { from: string; to: string }) {
    this.clock = clock;
    this.developerId = developerId;
    this.publicUrl = publicUrl;
  }

  createEndpoint(url: string, categories: Category[]): Endpoint & { signing_secret: string } {
    const now = this.clock.iso();
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    const endpoint: Endpoint = { id: newId('whr', this.clock.now()), url, event_categories: categories, active: false, secret, created_at: now, updated_at: now };
    this.endpoints.set(endpoint.id, endpoint);
    return { ...endpoint, signing_secret: secret };
  }

  /**
   * Records an event and delivers it to every active endpoint subscribed to its category.
   * The API's webhook envelope; event_id is stable per resource and topic.
   */
  emit(type: string, data: Record<string, unknown>, changes: { status: [string, string] } | null = null, envelope: EnvelopeOverrides = {}): SimEvent {
    const objectId = envelope.objectId ?? String(data.id);
    const id = eventId(objectId, type);
    const event: SimEvent = {
      id,
      type,
      createdAt: this.clock.now(),
      payload: {
        event_id: id,
        event_type: type,
        event_category: type.split('.')[0],
        event_developer_id: this.developerId,
        api_version: 'v1',
        event_created_at: envelope.occurredAt ?? this.clock.iso(),
        event_object_id: objectId,
        event_object_status: envelope.status ?? data.status,
        event_object_changes: changes,
        event_object: data,
      },
    };
    this.events.push(event);
    if (this.mode === 'silent') return event;

    const category = type.split('.')[0] as Category;
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.active || !endpoint.event_categories.includes(category)) continue;
      this.deliver(endpoint, event, 0, false);
      if (this.mode === 'noisy') {
        this.deliver(endpoint, event, 0, false); // duplicate
        if (!this.forgedOnce && this.forge) {
          const forged = this.forge(event);
          if (forged) {
            this.forgedOnce = true;
            this.deliver(endpoint, forged, 0, true);
          }
        }
      }
    }
    return event;
  }

  /** Re-sends an older event after a newer one (noisy mode: out of order). */
  replay(event: SimEvent): void {
    const category = event.type.split('.')[0] as Category;
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.active && endpoint.event_categories.includes(category)) this.deliver(endpoint, event, 0, false);
    }
  }

  private deliver(endpoint: Endpoint, event: SimEvent, attempt: number, forged: boolean): void {
    const body = JSON.stringify(event.payload);
    const msgId = `msg_${event.id}`;
    // Signed at the app's time: Svix rejects a timestamp more than 5 minutes off. The app's clock moves with
    // the sandbox's only when it runs with the app clock; otherwise it is the wall clock.
    const timestamp = Math.floor((this.clock.appFollows ? this.clock.now() : Date.now()) / 1000).toString();
    const key = forged ? randomBytes(24) : Buffer.from(endpoint.secret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${msgId}.${timestamp}.${body}`).digest('base64');
    const target = this.publicUrl && endpoint.url.startsWith(this.publicUrl.from) ? this.publicUrl.to + endpoint.url.slice(this.publicUrl.from.length) : endpoint.url;
    const job = fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': msgId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
      body,
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.status)
      .catch(() => 0)
      .then((status) => {
        this.deliveries.push({ eventId: event.id, type: event.type, endpointId: endpoint.id, attempt, status, forged, at: this.clock.iso() });
        const ok = status >= 200 && status < 300;
        // 4xx other than 408 and 429 stops the retries.
        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (!ok && !permanent && !forged && attempt < RETRY_DELAYS_MS.length && this.mode !== 'silent') {
          this.clock.after(RETRY_DELAYS_MS[attempt]!, () => this.deliver(endpoint, event, attempt + 1, false));
        }
      });
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  /** Resolves when no delivery is in flight. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}
