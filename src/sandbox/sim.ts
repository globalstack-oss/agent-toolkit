// The simulator behind the failure sandbox: a stateful fake of the GlobalStack /v1 API, with fault controls.
import { randomUUID } from 'node:crypto';
import { GlobalStack, type Behaviour } from './api.ts';
import { Clock } from './core.ts';
import { Events, type DeliveryMode, type SimEvent } from './events.ts';
import { SimHttp, type Faults } from './http.ts';
import { buildSeed, EVAL_IDS, type SeedOptions } from './seed.ts';

export { EVAL_IDS };

export interface SimOptions extends SeedOptions {
  secretKey: string;
  /** The app's public https origin and where it really listens: deliveries to the first go to the second. */
  publicUrl?: { from: string; to: string };
  /** The app's clock file (scripts/app-clock.mjs reads it): jumps move the app and the sim together. */
  clockFile?: string;
}

export class Sim {
  readonly clock: Clock;
  readonly events: Events;
  readonly gs: GlobalStack;
  readonly http: SimHttp;
  url = '';

  constructor(options: SimOptions) {
    this.clock = new Clock(options.clockFile);
    this.events = new Events(this.clock, EVAL_IDS.integrationId, options.publicUrl);
    this.gs = new GlobalStack(buildSeed(options), this.clock, this.events);
    this.http = new SimHttp(this.clock, options.secretKey);
    this.gs.register(this.http);
    this.events.forge = (real) => this.forge(real);
  }

  async listen(port = 0): Promise<string> {
    this.url = await this.http.listen(port);
    return this.url;
  }

  async close(): Promise<void> {
    this.clock.stop();
    await this.events.drain();
    await this.http.close();
  }

  set faults(f: Faults) {
    this.http.faults = f;
  }

  set behaviour(b: Partial<Behaviour>) {
    Object.assign(this.gs.behaviour, b);
  }

  set delivery(mode: DeliveryMode) {
    this.events.mode = mode;
  }

  /** Moves simulated time forward, for the sim and the app. */
  jump(ms: number): Promise<void> {
    return this.clock.jump(ms);
  }

  /**
   * The forged event for noisy delivery: the opposite outcome of the real event, for the same resource,
   * signed with the wrong key. An app that trusts it moves money on a lie.
   */
  private forge(real: SimEvent): SimEvent | null {
    const [kind, status] = real.type.split('.');
    if (!kind || !['onramp', 'offramp', 'conversion', 'transfer'].includes(kind)) return null;
    if (status !== 'processing') return null;
    const object = real.payload.event_object as Record<string, unknown>;
    const outcome = kind === 'onramp' ? 'success' : 'failed';
    // An onramp forgery claims ten times the USDC; a payout forgery claims failure. Trusting either moves money wrongly.
    const inflated = (Number(object.destination_amount) * 10).toFixed(6);
    const fake = { ...object, status: outcome, ...(outcome === 'success' ? { received_amount: inflated, actual_destination_amount: inflated } : { failure_reason: 'failed', failure_reason_message: 'The payment failed at the provider.' }) };
    const id = `evt_${randomUUID()}`;
    return {
      id,
      type: `${kind}.${outcome}`,
      createdAt: this.clock.now(),
      payload: { ...real.payload, event_id: id, event_type: `${kind}.${outcome}`, event_object_status: outcome, event_object_changes: { status: [status, outcome] }, event_object: fake },
    };
  }
}
