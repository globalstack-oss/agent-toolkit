// Shared setup for the simulator's flow checks: a simulator whose webhooks reach a local Svix-verifying receiver.
// Each flow runs its checks in order and calls done(), which throws if any check failed.
import { createServer, type Server } from 'node:http';
import { Webhook } from 'svix';
import { Sim } from '../../src/sandbox/sim.ts';

export const KEY = 'gsa_sk_live_test';

export interface Harness {
  sim: Sim;
  call: (method: string, path: string, body?: unknown, key?: string) => Promise<{ status: number; json: any }>;
  /** Verified webhook bodies, in arrival order. */
  received: any[];
  /** Subscribes an https endpoint (mapped to the local receiver) and activates it. */
  subscribe: (categories: string[]) => Promise<void>;
  waitFor: (what: string, pred: () => boolean, ms?: number) => Promise<boolean>;
  close: () => Promise<void>;
}

let failures: string[] = [];
export function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures.push(`${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
}

export function done(): void {
  if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
}

export async function setup(): Promise<Harness> {
  failures = [];
  const secrets: string[] = [];
  const received: any[] = [];
  const hook: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      for (const secret of secrets) {
        try {
          received.push(new Webhook(secret).verify(raw, req.headers as any));
          res.writeHead(200).end();
          return;
        } catch {
          // try the next endpoint's secret
        }
      }
      res.writeHead(400).end();
    });
  }).listen(0);
  await new Promise((r) => hook.once('listening', r));
  const port = (hook.address() as any).port;
  const sim = new Sim({ secretKey: KEY, publicUrl: { from: 'https://hooks.eval.test', to: `http://127.0.0.1:${port}` } });
  sim.behaviour = { stepMs: 50 };
  const base = await sim.listen();
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const subscribe = async (categories: string[]) => {
    const ep = await call('POST', '/v1/notifications/webhooks', { url: 'https://hooks.eval.test/hooks', event_categories: categories });
    secrets.push(ep.json.data.signing_secret);
    await call('PATCH', `/v1/notifications/webhooks/${ep.json.data.id}`, { active: true });
  };
  const waitFor = async (what: string, pred: () => boolean, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await sim.events.drain();
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    check(`waited for ${what}`, false);
    return false;
  };
  const close = async () => {
    await sim.close();
    hook.close();
  };
  return { sim, call, received, subscribe, waitFor, close };
}
