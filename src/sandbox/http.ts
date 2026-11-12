// The HTTP layer of gs-sim: routing, the real envelopes, auth, idempotency and fault injection.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, newId, type Clock } from './core.ts';

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  rawBody: string;
  idempotencyKey: string | null;
  requestId: string;
}

/** What a handler returns: data, plus pagination when it lists. */
export interface Reply {
  data: unknown;
  status?: number;
  message?: string;
  page?: { page: number; per_page: number; total: number; has_more: boolean };
}

export type Handler = (req: Request) => Reply | Promise<Reply>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Money-moving or setup POST that honours Idempotency-Key (per the OpenAPI). */
  idempotent: boolean;
}

/** A logged request, for the grader and for debugging a build. */
export interface Logged {
  at: string;
  method: string;
  path: string;
  status: number;
  code: string;
  idempotencyKey: string | null;
  body: unknown;
  /** For a GET: the id and status of each resource in the response, so a report can tell what the app has seen. */
  seen?: Array<{ id: string; status: string }>;
}

/**
 * Faults the grader arms before a scenario. Each one-shot fault counts down as it fires.
 * `match` is tested against "METHOD /path" with ids replaced by their prefix, e.g. "POST /v1/offramps".
 */
export interface Faults {
  /** The next `count` matching requests answer 429 rate_limited. */
  rateLimit?: { match: RegExp; count: number };
  /** The next `count` executes run, then the connection drops before any response. */
  dropResponse?: { match: RegExp; count: number };
  /** The next matching execute runs, then waits for `release()` before answering. Used to crash the app mid-call. */
  hold?: { match: RegExp; armed: boolean };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,255}$/;
const DAY = 24 * 3600 * 1000;

export class SimHttp {
  readonly routes: Route[] = [];
  readonly log: Logged[] = [];
  faults: Faults = {};
  /** Serves GETs only (the MCP arm's build-time view of the account). */
  readOnly = false;
  /** Routes the real API has and this simulator does not: they answer 501 not_in_sandbox instead of the 403 for unknown routes. */
  notSimulated: RegExp[] = [];
  /** Real time of the last request, so the grader can tell when the app has gone quiet. */
  lastRequestAt = Date.now();
  private server: Server | null = null;
  private readonly idem = new Map<string, { hash: string; at: number; status?: number; stored?: { status: boolean; message: string; code: string; data: unknown }; inProgress: boolean }>();
  private held: Array<() => void> = [];
  private heldWaiters: Array<() => void> = [];
  private readonly clock: Clock;
  private readonly secretKey: string;

  constructor(clock: Clock, secretKey: string) {
    this.clock = clock;
    this.secretKey = secretKey;
  }

  route(method: string, path: string, handler: Handler, idempotent = false): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/\/$/, '').replace(/\{(\w+)\}/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) + '/?$',
    );
    this.routes.push({ method, pattern, keys, handler, idempotent });
  }

  listen(port: number): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) =>
      this.server!.listen(port, '127.0.0.1', () => {
        const address = this.server!.address();
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
      }),
    );
  }

  close(): Promise<void> {
    for (const release of this.held) release();
    this.held = [];
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  /** Resolves once a held execute is waiting. */
  waitForHold(): Promise<void> {
    if (this.held.length) return Promise.resolve();
    return new Promise((resolve) => this.heldWaiters.push(resolve));
  }

  /** Lets held executes answer (or drop, if the app is gone). */
  release(): void {
    const held = this.held;
    this.held = [];
    for (const release of held) release();
  }

  private meta(requestId: string) {
    return { request_id: requestId, timestamp: this.clock.isoSeconds(), version: '1' };
  }

  private send(res: ServerResponse, status: number, body: unknown): string {
    const text = JSON.stringify(body);
    if (!res.destroyed) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    }
    return text;
  }

  private errorBody(err: ApiError, requestId: string) {
    return {
      status: false,
      message: err.message,
      code: err.code,
      data: err.data ?? null,
      meta: {
        next_steps: { action: err.nextSteps[0] ?? 'Check the request and try again.', docs_url: `https://docs.globalstack.io/errors#${err.code}` },
        ...this.meta(requestId),
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const requestId = newId('req', this.clock.now());
    this.lastRequestAt = Date.now();
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const label = `${method} ${path.replace(/\/[a-z]+_[0-9A-Z]{26}/g, (m) => '/' + m.slice(1, m.indexOf('_')) + '_')}`;
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    const logEntry: Logged = { at: this.clock.iso(), method, path: url.pathname + url.search, status: 0, code: '', idempotencyKey, body: null };
    this.log.push(logEntry);

    const fail = (err: ApiError) => {
      logEntry.status = err.status;
      logEntry.code = err.code;
      return this.send(res, err.status, this.errorBody(err, requestId));
    };

    if (req.headers.authorization !== `Bearer ${this.secretKey}`) {
      fail(new ApiError(401, 'authentication_failed', 'Invalid or missing API key.'));
      return;
    }

    if (this.readOnly && method !== 'GET') {
      fail(new ApiError(403, 'forbidden', 'Insufficient role for this operation.'));
      return;
    }

    const route = this.routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route && this.notSimulated.some((p) => p.test(`${method} ${path}`))) {
      fail(new ApiError(501, 'not_in_sandbox', 'This route exists in the GlobalStack API, but the sandbox does not simulate it. Check its behaviour in the docs.'));
      return;
    }
    if (!route) {
      // A catch-all proxy answers unknown /v1 routes and methods with 403.
      fail(new ApiError(403, 'forbidden', 'Insufficient role for this operation.'));
      return;
    }

    // The money write limiter: no Retry-After header.
    const rl = this.faults.rateLimit;
    if (rl && rl.count > 0 && rl.match.test(label)) {
      rl.count -= 1;
      fail(new ApiError(429, 'rate_limited', 'Too many requests. Slow down and retry shortly.'));
      return;
    }

    let body: any = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        fail(new ApiError(400, 'internal_error', 'Internal server error'));
        return;
      }
    }
    logEntry.body = body;

    // Idempotency: scoped to the integration, not the path. Only successes are stored;
    // a replay returns the stored body with a fresh meta. In-progress is checked before the body hash.
    let idemSlot: string | null = null;
    if (route.idempotent && method === 'POST' && idempotencyKey !== null) {
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        fail(new ApiError(400, 'invalid_input', 'Idempotency-Key must match ^[A-Za-z0-9_\\-]{8,255}$'));
        return;
      }
      const hash = createHash('sha256').update(rawBody).digest('hex');
      const slot = idempotencyKey;
      const found = this.idem.get(slot);
      if (found && this.clock.now() - found.at < DAY) {
        if (found.inProgress) {
          fail(new ApiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still in progress'));
          return;
        }
        if (found.hash !== hash) {
          fail(new ApiError(409, 'idempotency_conflict', 'Idempotency-Key already used with a different request body'));
          return;
        }
        if (found.stored) {
          logEntry.status = found.status!;
          logEntry.code = 'replayed';
          this.send(res, found.status!, { ...found.stored, meta: this.meta(requestId) });
          return;
        }
      }
      this.idem.set(slot, { hash, at: this.clock.now(), inProgress: true });
      idemSlot = slot;
    }

    const params: Record<string, string> = {};
    const m = route.pattern.exec(path)!;
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));

    let reply: Reply;
    try {
      reply = await route.handler({ method, path, params, query: url.searchParams, body, rawBody, idempotencyKey, requestId });
    } catch (err) {
      if (idemSlot) this.idem.delete(idemSlot);
      if (err instanceof ApiError) {
        fail(err);
        return;
      }
      console.error('gs-sim handler crashed', err);
      fail(new ApiError(500, 'internal_error', 'Internal error'));
      return;
    }

    const status = reply.status ?? 200;
    const envelope = {
      status: true,
      message: reply.message ?? 'Request successful',
      code: 'ok',
      data: reply.data,
      meta: reply.page ? { ...reply.page, ...this.meta(requestId) } : this.meta(requestId),
    };
    if (idemSlot) {
      this.idem.set(idemSlot, { ...this.idem.get(idemSlot)!, inProgress: false, status, stored: { status: true, message: envelope.message, code: 'ok', data: JSON.parse(JSON.stringify(envelope.data)) } });
    }
    logEntry.status = status;
    logEntry.code = 'ok';
    if (method === 'GET') logEntry.seen = statusesIn(reply.data);

    const drop = this.faults.dropResponse;
    if (drop && drop.count > 0 && drop.match.test(label)) {
      drop.count -= 1;
      logEntry.code = 'dropped';
      req.socket.destroy();
      return;
    }
    const hold = this.faults.hold;
    if (hold?.armed && hold.match.test(label)) {
      hold.armed = false;
      logEntry.code = 'held';
      await new Promise<void>((resolve) => {
        this.held.push(resolve);
        for (const w of this.heldWaiters.splice(0)) w();
      });
    }
    this.send(res, status, envelope);
  }
}

/** The id and status of each resource in a response: one object, or a list of them. */
function statusesIn(data: unknown): Array<{ id: string; status: string }> {
  const items = Array.isArray(data) ? data : [data];
  return items.flatMap((x) => (x && typeof x.id === 'string' && typeof x.status === 'string' ? [{ id: x.id, status: x.status }] : []));
}

/** Reads page/per_page and slices a list the way the API paginates. */
export function paginate<T>(items: T[], query: URLSearchParams): Reply {
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const perPage = Math.min(200, Math.max(1, Number(query.get('per_page') ?? 50) || 50));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return { data: slice, page: { page, per_page: perPage, total: items.length, has_more: page * perPage < items.length } };
}
