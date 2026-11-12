export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One API call a tool may make. `path` is a template, e.g. `/v1/wallets/{id}`. */
export interface ApiCall {
  method: HttpMethod;
  path: string;
}

export const API_BASE_URL = 'https://api.globalstack.io';
const DEFAULT_TIMEOUT_MS = 30_000;

export type ApiResult =
  | { ok: true; status: number; data: unknown; meta: unknown }
  | {
      ok: false;
      status: number | null;
      code: string;
      /** For the developer and the agent. Never show it to an end user. */
      developer_message: string;
      next_steps: unknown;
      request_id: string | null;
    };

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

/** Thrown before anything leaves the machine when a tool tries a call it did not declare. */
export class CallNotAllowedError extends Error {
  constructor(method: HttpMethod, path: string) {
    super(`Blocked: ${method} ${path} is not declared by this tool.`);
    this.name = 'CallNotAllowedError';
  }
}

/** Fills `{param}` slots. Each value is URL-encoded, so a value cannot add path segments. */
export function buildPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
}

function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/\{\w+\}/)
    .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${pattern}$`);
}

/** `.` and `..` segments (also as `%2e`) are resolved by `new URL()` and could reach an undeclared path. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

export function isDeclared(calls: readonly ApiCall[], method: HttpMethod, path: string): boolean {
  if (hasDotSegment(path)) return false;
  return calls.some((call) => call.method === method && templateToRegExp(call.path).test(path));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Null when the bearer key may go to `baseUrl`: https, or http to this machine for the local simulator. Otherwise
 * the reason, so a mistyped or planted GLOBALSTACK_API_BASE_URL cannot send the key elsewhere in clear text.
 */
export function unsafeBaseUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `GLOBALSTACK_API_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}.`;
  }
  if (url.username || url.password) return 'GLOBALSTACK_API_BASE_URL must not contain a user name or password.';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return `GLOBALSTACK_API_BASE_URL must be https (or http to localhost, 127.0.0.1 or ::1 for the simulator), not ${url.protocol}//${url.host}. The API key was not sent.`;
}

export interface ClientOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GlobalStackClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl ?? API_BASE_URL;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get hasApiKey(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** A client that can only make the calls one tool declares. */
  scoped(calls: readonly ApiCall[]): ScopedClient {
    return new ScopedClient(this, calls);
  }

  /** @internal Use `scoped()`. */
  async send(method: HttpMethod, path: string, opts: RequestOptions): Promise<ApiResult> {
    if (!this.options.apiKey) {
      return {
        ok: false,
        status: null,
        code: 'missing_api_key',
        developer_message: 'GLOBALSTACK_API_KEY is not set. Add it to the MCP server config and restart the agent.',
        next_steps: null,
        request_id: null,
      };
    }
    const unsafe = unsafeBaseUrl(this.baseUrl);
    if (unsafe) return { ok: false, status: null, code: 'unsafe_base_url', developer_message: unsafe, next_steps: null, request_id: null };

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A DOMException, which is not always `instanceof Error` across realms.
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      return {
        ok: false,
        status: null,
        code: timedOut ? 'timeout' : 'network_error',
        developer_message: timedOut
          ? `No answer from Global Stack after ${this.timeoutMs / 1000} s.`
          : `Could not reach Global Stack: ${error instanceof Error ? error.message : String(error)}`,
        next_steps: null,
        request_id: null,
      };
    }

    let envelope: any;
    try {
      envelope = await response.json();
    } catch {
      return {
        ok: false,
        status: response.status,
        code: 'invalid_response',
        developer_message: `Global Stack returned HTTP ${response.status} with a body that is not JSON.`,
        next_steps: null,
        request_id: null,
      };
    }

    if (response.ok && (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope))) {
      return {
        ok: false,
        status: response.status,
        code: 'invalid_response',
        developer_message: `Global Stack returned HTTP ${response.status} with a body that is not a JSON object.`,
        next_steps: null,
        request_id: null,
      };
    }
    if (response.ok && envelope.status !== false) {
      return { ok: true, status: response.status, data: envelope?.data ?? null, meta: envelope?.meta ?? null };
    }
    return {
      ok: false,
      status: response.status,
      code: typeof envelope?.code === 'string' ? envelope.code : 'unknown_error',
      developer_message: typeof envelope?.message === 'string' ? envelope.message : '',
      next_steps: envelope?.meta?.next_steps ?? null,
      request_id: envelope?.meta?.request_id ?? null,
    };
  }
}

export class ScopedClient {
  constructor(
    private readonly client: GlobalStackClient,
    private readonly calls: readonly ApiCall[],
  ) {}

  request(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<ApiResult> {
    const pathOnly = path.split('?')[0] ?? path;
    if (pathOnly !== path || !isDeclared(this.calls, method, path)) {
      throw new CallNotAllowedError(method, path);
    }
    return this.client.send(method, path, opts);
  }
}
