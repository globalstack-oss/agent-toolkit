import type { ApiResult, ScopedClient } from '../api/client';
import { routeStatus } from './routes';

type Row = Record<string, any>;
type Status = 'ok' | 'warn' | 'fail' | 'unknown';
export interface SetupCheck {
  check: string;
  status: Status;
  detail: string;
  next_step?: string;
}

export const SETUP_CALLS = [
  { method: 'GET', path: '/v1/me' },
  { method: 'GET', path: '/v1/currencies' },
  { method: 'GET', path: '/v1/currencies/access-requests' },
  { method: 'GET', path: '/v1/notifications/webhooks' },
  { method: 'GET', path: '/v1/wallets' },
] as const;

/** The only key role that cannot move money (the API: read needs Viewer, write needs Developer). */
const VIEWER = 'consumer_viewer';

const unknown = (check: string, result: Extract<ApiResult, { ok: false }>): SetupCheck => ({
  check,
  status: 'unknown',
  detail: `Could not read it (${result.code}).`,
});

export interface SetupTarget {
  currency?: string;
  country_code?: string;
  direction?: 'onramp' | 'offramp' | 'conversion' | 'transfer';
  /** Webhook categories the flow needs, e.g. ["offramp"]. */
  webhook_categories?: string[];
}

/** Read-only. Uses only calls the other read tools already make. */
export async function runSetupChecks(api: ScopedClient, target: SetupTarget = {}): Promise<SetupCheck[]> {
  // The catalog names the conversion capability can_convert; the others match the direction.
  const capability = target.direction ? { [target.direction === 'conversion' ? 'can_convert' : `can_${target.direction}`]: true } : {};
  const [currencies, access, webhooks, wallets, me] = await Promise.all([
    api.request('GET', '/v1/currencies', { query: { code: target.currency, country_code: target.country_code, per_page: 200, ...capability } }),
    api.request('GET', '/v1/currencies/access-requests'),
    api.request('GET', '/v1/notifications/webhooks'),
    api.request('GET', '/v1/wallets', { query: { per_page: 50 } }),
    api.request('GET', '/v1/me'),
  ]);
  const checks: SetupCheck[] = [];

  // Routes
  if (!currencies.ok) checks.push(unknown('route', currencies));
  else {
    const requests = access.ok && Array.isArray(access.data) ? (access.data as Row[]) : [];
    const rows = (currencies.data as Row[]).map((row) => ({ row, status: routeStatus(row, requests) }));
    const label = [target.currency, target.country_code, target.direction].filter(Boolean).join(' ') || 'any';
    const open = rows.filter((r) => r.status === 'open');
    if (open.length > 0) {
      checks.push({ check: 'route', status: 'ok', detail: `${open.length} open route(s) for ${label}.` });
    } else if (rows.length === 0) {
      checks.push({ check: 'route', status: 'fail', detail: `No route for ${label}.`, next_step: 'Stop. Tell the user this flow is not available. Do not switch networks to work around it.' });
    } else {
      const { row, status } = rows[0]!;
      checks.push({
        check: 'route',
        status: status.startsWith('access_pending') ? 'warn' : 'fail',
        detail: `${row.code} ${row.country_code ?? ''} is ${status}.`.replace('  ', ' '),
        next_step:
          status === 'needs_access'
            ? `Ask the developer before requesting access: POST /v1/currencies/${row.code}/access-requests with country_code ${row.country_code}.`
            : status.startsWith('access_')
              ? 'Wait for Global Stack to answer the access request.'
              : 'Check the customer restrictions with gs.mjs list_supported_routes.',
      });
    }
  }

  // Access requests
  if (!access.ok) checks.push(unknown('access_requests', access));
  else {
    const rows = (access.data as Row[]) ?? [];
    const pending = rows.filter((r) => r.status === 'pending');
    const rejected = rows.filter((r) => r.status === 'rejected');
    checks.push({
      check: 'access_requests',
      status: rejected.length ? 'warn' : 'ok',
      detail: `${pending.length} pending, ${rejected.length} rejected.`,
      next_step: rejected.length ? `Contact Global Stack about ${rejected.map((r) => r.resource_code).join(', ')}.` : undefined,
    });
  }

  // Webhooks
  if (!webhooks.ok) checks.push(unknown('webhooks', webhooks));
  else {
    const rows = (webhooks.data as Row[]) ?? [];
    const active = rows.filter((r) => r.active === true);
    const inactive = rows.length - active.length;
    const covered = new Set(active.flatMap((r) => (Array.isArray(r.event_categories) ? r.event_categories : [])));
    const missing = (target.webhook_categories ?? []).filter((c) => !covered.has(c));
    const bad = active.length === 0 || missing.length > 0;
    checks.push({
      check: 'webhooks',
      status: bad ? 'warn' : 'ok',
      detail: `${active.length} active, ${inactive} inactive.${missing.length ? ` No active endpoint for: ${missing.join(', ')}.` : ''}`,
      next_step: bad
        ? inactive > 0 && active.length === 0
          ? 'Activate an endpoint: PATCH /v1/notifications/webhooks/{id} with active true. A new endpoint starts inactive.'
          : `Create an endpoint (POST /v1/notifications/webhooks) for ${missing.join(', ') || 'your flows'}, then activate it. ensureWebhook in code/webhooks.ts does both.`
        : undefined,
    });
  }

  // Wallets
  if (!wallets.ok) checks.push(unknown('wallets', wallets));
  else {
    const rows = (wallets.data as Row[]) ?? [];
    const funded = rows.filter((w) => Number(w.available_balance) > 0);
    checks.push({
      check: 'wallets',
      status: rows.length === 0 || funded.length === 0 ? 'warn' : 'ok',
      detail: rows.length
        ? rows.slice(0, 10).map((w) => `${w.id}: ${w.available_balance} ${w.currency}`).join('; ')
        : 'No wallets.',
      next_step: funded.length === 0 ? 'Fund a wallet with the smallest amount the corridor allows before a live test.' : undefined,
    });
  }

  // The key in the agent's shell. The scripts only read, so a Viewer key is enough; anything above it can move money.
  if (!me.ok) checks.push(unknown('api_key', me));
  else {
    const data = (me.data ?? {}) as Row;
    // effective_role is what the key acts as: the lower of the key's role and its owner's membership.
    const role = String(data.effective_role ?? data.api_key?.role ?? '');
    checks.push(
      !role
        ? { check: 'api_key', status: 'unknown', detail: 'The answer did not say which role this key acts as.' }
        : role === VIEWER
          ? { check: 'api_key', status: 'ok', detail: 'Read-only key (Viewer role).' }
          : {
              check: 'api_key',
              status: 'warn',
              detail: `This key acts as ${role}, which can move money. The scripts only read, but the key sits in the agent's shell.`,
              next_step:
                "Tell the developer once, then carry on: create an API key with the Viewer role in the Global Stack dashboard and set it as GLOBALSTACK_API_KEY where the agent runs. The app's own key belongs in its deploy environment, not in a file in the project.",
            },
    );
  }

  return checks;
}
