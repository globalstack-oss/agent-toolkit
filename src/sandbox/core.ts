// Shared pieces of gs-sim: ids, the simulated clock, exact decimal math, and API errors.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ── Ids ───────────────────────────────────────────────────────────────────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-style id with a GlobalStack prefix, e.g. `ofr_01M3...`. Sortable by creation time. */
export function newId(prefix: string, nowMs: number): string {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return `${prefix}_${time}${rand}`;
}

// ── Clock ─────────────────────────────────────────────────────────────────────
/**
 * Simulated time: real time plus an offset `sandbox.mjs advance` pushes forward. Jobs scheduled on it fire
 * when simulated time reaches them, so a 3-hour jump fires everything due within those 3 hours.
 * With an app clock file (`start --app-clock`, read by scripts/app-clock.mjs in the app), the same offset is
 * written there, so the app's clock and timers move too. Without one, only the sandbox's clock moves.
 */
export class Clock {
  private offset = 0;
  private holding = false;
  private jobs: Array<{ at: number; run: () => void }> = [];
  private ticker: NodeJS.Timeout;
  private readonly clockFile: string | undefined;

  constructor(clockFile?: string) {
    this.clockFile = clockFile;
    if (clockFile) writeFileSync(clockFile, '0');
    this.ticker = setInterval(() => this.fireDue(), 25);
    this.ticker.unref();
  }

  now(): number {
    return Date.now() + this.offset;
  }

  /** Whether the app's clock moves with this one (an app clock file is in use). */
  get appFollows(): boolean {
    return this.clockFile !== undefined;
  }

  iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  /** Envelope timestamps have no milliseconds. */
  isoSeconds(ms = this.now()): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Runs `run` once simulated time passes `delayMs` from now. */
  after(delayMs: number, run: () => void): void {
    this.jobs.push({ at: this.now() + delayMs, run });
  }

  /** Moves time forward. Waits for the app's clock to catch up before anything due runs, so a webhook
   * signed just after the jump is not "from the future" to the app. */
  async jump(ms: number): Promise<void> {
    this.holding = true;
    this.offset += ms;
    if (this.clockFile) {
      writeFileSync(this.clockFile, String(this.offset));
      await new Promise((r) => setTimeout(r, 300));
    }
    this.holding = false;
    this.fireDue();
  }

  stop(): void {
    clearInterval(this.ticker);
    this.jobs = [];
  }

  private fireDue(): void {
    if (this.holding) return;
    const now = this.now();
    const due = this.jobs.filter((j) => j.at <= now).sort((a, b) => a.at - b.at);
    if (!due.length) return;
    this.jobs = this.jobs.filter((j) => j.at > now);
    for (const job of due) job.run();
  }
}

// ── Exact decimals ────────────────────────────────────────────────────────────
/** Amounts are held as bigint with 8 decimal places. No floats anywhere. */
const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

export type Units = bigint;

/** Parses a decimal string. Returns null for anything that is not a plain non-negative decimal. */
export function parseAmount(value: unknown): Units | null {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  if (frac.length > SCALE) return null;
  return BigInt(whole!) * ONE + BigInt(frac.padEnd(SCALE, '0'));
}

export function decimalPlaces(value: string): number {
  return value.includes('.') ? value.split('.')[1]!.length : 0;
}

/** Formats with exactly `places` decimals, rounding down. */
export function formatAmount(units: Units, places: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const step = 10n ** BigInt(SCALE - places);
  const truncated = (abs / step) * step;
  const whole = truncated / ONE;
  const frac = (truncated % ONE).toString().padStart(SCALE, '0').slice(0, places);
  return `${negative ? '-' : ''}${whole}${places ? `.${frac}` : ''}`;
}

/** a × rate, where rate is itself a decimal in Units. Rounds down. */
export function mul(a: Units, rate: Units): Units {
  return (a * rate) / ONE;
}

/** a ÷ rate. Rounds down. */
export function div(a: Units, rate: Units): Units {
  return (a * ONE) / rate;
}

/** a ÷ rate. Rounds up, so the target is never short. */
export function divUp(a: Units, rate: Units): Units {
  return (a * ONE + rate - 1n) / rate;
}

export function roundDown(units: Units, places: number): Units {
  const step = 10n ** BigInt(SCALE - places);
  return (units / step) * step;
}

export function roundUp(units: Units, places: number): Units {
  const step = 10n ** BigInt(SCALE - places);
  return ((units + step - 1n) / step) * step;
}

export const units = (value: string): Units => {
  const parsed = parseAmount(value);
  if (parsed === null) throw new Error(`bad decimal ${value}`);
  return parsed;
};

// ── Errors ────────────────────────────────────────────────────────────────────
/** An API error the sim answers with the real error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly nextSteps: string[];
  readonly data: unknown;

  constructor(status: number, code: string, message: string, nextSteps: string[] = [], data: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.nextSteps = nextSteps;
    this.data = data;
  }
}

/** A validation failure: 400 bad_request with the failing fields. */
export const badRequest = (field: string, message: string) => refusedFields([[false, field, message]])!;

/**
 * The API checks every field of a request body and reports all failures in one 400. Each check is
 * [passes, field, message]; returns the error to throw, or null when every check passes.
 */
export function refusedFields(checks: Array<[boolean, string, string]>): ApiError | null {
  const errors = checks.filter(([ok]) => !ok).map(([, field, message]) => ({ field, messages: [message] }));
  return errors.length ? new ApiError(400, 'bad_request', "Invalid body, check 'errors' property for more info.", [], { errors }) : null;
}

export const notFound = (resource: string, id: string) =>
  new ApiError(404, 'not_found', `${resource} '${id}' not found`);
