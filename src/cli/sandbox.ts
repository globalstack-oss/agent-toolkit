// sandbox.mjs: a local copy of the Global Stack API that fails on purpose. It never calls the real API.
//
//   node sandbox.mjs start --app-port 3000 [--fault lost_response] [--xaf-access pending] [--app-clock]
//   node sandbox.mjs report
//   node sandbox.mjs advance --hours 3
//   node sandbox.mjs pay [onr_...]                       the payer's bank transfer for a bank onramp
//   node sandbox.mjs return <id>                         a successful onramp, offramp or conversion is returned
//   node sandbox.mjs kyc approve|reject|start <cust_...> [--retry]
//   node sandbox.mjs deposit <address|da_...|wcr_...> <amount>
//   node sandbox.mjs approve-access <currency> [--country CM]
//   node sandbox.mjs stop
//
// `start` runs the sandbox as a background process and returns once it listens. The other commands talk to it
// through a control port on 127.0.0.1, written with a random token to .globalstack-sandbox/state.json in the current
// folder. `report` also records which fault was tested, and how it went, in .globalstack-sandbox/runs.json.
// A sandbox with no request for IDLE_HOURS stops on its own.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advanceSandbox, approveAccess, FAULTS, type Fault, kycVerdict, payOnramp, returnMovement, runningSandbox, sandboxReport, simulateDeposit, startSandbox, stopSandbox } from '../sandbox';
import { faultCoverage, readRuns, recordRun, SANDBOX_DIR, sandboxDir } from '../sandbox/coverage';

const STATE = resolve(process.cwd(), SANDBOX_DIR, 'state.json');
const LOG = resolve(process.cwd(), SANDBOX_DIR, 'sandbox.log');
const CLOCK = resolve(process.cwd(), SANDBOX_DIR, 'clock');
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const IDLE_HOURS = 4;

interface State {
  pid: number;
  control_port: number;
  token: string;
  started_at: string;
  started: unknown;
}

type Row = Record<string, any>;

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const NOT_RUNNING = { ok: false, code: 'not_running', developer_message: 'No sandbox is running here. Run: node sandbox.mjs start --app-port <port>' };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running sandbox's state, or null. A state file left by a process that is gone is removed. */
function readState(): State | null {
  if (!existsSync(STATE)) return null;
  let state: State;
  try {
    state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
  } catch {
    return null; // being written
  }
  if (alive(state.pid)) return state;
  rmSync(STATE, { force: true });
  return null;
}

async function control(path: string, method: 'GET' | 'POST' = 'POST'): Promise<Row> {
  const state = readState();
  if (!state) return NOT_RUNNING;
  try {
    const response = await fetch(`http://127.0.0.1:${state.control_port}${path}`, { method, headers: { 'x-sandbox-token': state.token } });
    return (await response.json()) as Row;
  } catch {
    return { ok: false, code: 'not_running', developer_message: 'The sandbox process does not answer. Start it again.' };
  }
}

async function serve(appPort: number, fault: Fault, xafAccess: 'pending' | 'approved', appClock: boolean): Promise<void> {
  const started = await startSandbox({ app_port: appPort, fault, xaf_access: xafAccess, ...(appClock ? { app_clock_file: CLOCK } : {}) });
  const token = randomBytes(24).toString('hex');
  let lastControl = Date.now();
  const routes: Record<string, (q: URLSearchParams) => unknown> = {
    'GET /report': () => sandboxReport(),
    'POST /advance': (q) => advanceSandbox(Number(q.get('hours'))),
    'POST /pay': (q) => payOnramp(q.get('id') ?? undefined),
    'POST /return': (q) => returnMovement(q.get('id') ?? ''),
    'POST /kyc': (q) => kycVerdict(q.get('action') as 'approve' | 'reject' | 'start', q.get('customer') ?? '', q.get('retry') === 'true'),
    'POST /deposit': (q) => simulateDeposit(q.get('target') ?? '', q.get('amount') ?? ''),
    'POST /approve-access': (q) => approveAccess(q.get('currency') ?? '', q.get('country') ?? undefined),
  };
  const shutdown = async (why: string) => {
    appendFileSync(LOG, `${new Date().toISOString()} stopping: ${why}\n`);
    await stopSandbox();
    // A new sandbox may already have written its own state: remove the file only if it is still ours.
    try {
      if ((JSON.parse(readFileSync(STATE, 'utf8')) as State).pid === process.pid) rmSync(STATE, { force: true });
    } catch {
      // no state file
    }
    process.exit(0);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers['x-sandbox-token'] !== token) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    lastControl = Date.now();
    if (req.method === 'POST' && url.pathname === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, stopped: true }), () => void shutdown('stop command'));
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    const body = route ? await route(url.searchParams) : { ok: false, code: 'not_found' };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  // A forgotten sandbox stops on its own once neither the app nor the commands have used it for IDLE_HOURS.
  setInterval(() => {
    const lastApi = runningSandbox()?.http.lastRequestAt ?? 0;
    if (Date.now() - Math.max(lastApi, lastControl) > IDLE_HOURS * 3600_000) void shutdown(`idle for ${IDLE_HOURS} hours`);
  }, 60_000).unref();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    writeFileSync(STATE, JSON.stringify({ pid: process.pid, control_port: port, token, started_at: new Date().toISOString(), started } satisfies State, null, 2));
  });
}

/** How to start the app so `advance` moves its clock too. */
function appClockSetup() {
  return {
    note: "Start your app with these variables so sandbox.mjs advance moves your app's clock with the sandbox's: Date and your timers jump together. Only for the app under test.",
    node: { NODE_OPTIONS: `--import ${pathToFileURL(join(SCRIPTS, 'app-clock.mjs')).href}`, GLOBALSTACK_SANDBOX_CLOCK: CLOCK },
    python: { PYTHONPATH: join(SCRIPTS, 'pyclock'), GLOBALSTACK_SANDBOX_CLOCK: CLOCK },
  };
}

const USAGE = [
  'node sandbox.mjs start --app-port <port> [--fault <fault>] [--xaf-access pending|approved] [--app-clock]',
  'node sandbox.mjs report',
  'node sandbox.mjs advance --hours <n>',
  'node sandbox.mjs pay [onr_...]',
  'node sandbox.mjs return <onr_|ofr_|con_ id>',
  'node sandbox.mjs kyc approve|reject|start <cust_...> [--retry]',
  'node sandbox.mjs deposit <address|da_...|wcr_...> <amount>',
  'node sandbox.mjs approve-access <currency> [--country <code>]',
  'node sandbox.mjs stop',
];

const invalid = (developer_message: string) => (print({ ok: false, code: 'invalid_input', developer_message, usage: USAGE }), 1);

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'app-port': { type: 'string' },
      fault: { type: 'string', default: 'none' },
      'xaf-access': { type: 'string', default: 'approved' },
      'app-clock': { type: 'boolean', default: false },
      hours: { type: 'string' },
      retry: { type: 'boolean', default: false },
      country: { type: 'string' },
    },
  });
  const q = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

  if (command === 'serve' || command === 'start') {
    const appPort = Number(values['app-port']);
    const fault = values.fault as Fault;
    const xaf = values['xaf-access'] as 'pending' | 'approved';
    if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535 || !FAULTS.includes(fault) || !['pending', 'approved'].includes(xaf)) {
      return invalid(`Give --app-port <your app's port>. --fault is one of: ${FAULTS.join(', ')}. --xaf-access is pending or approved.`);
    }
    if (command === 'serve') {
      await serve(appPort, fault, xaf, values['app-clock']!);
      return -1; // keep running
    }
    const previous = readState();
    if (previous) {
      // One sandbox at a time: starting again replaces it. Wait for the old process to exit.
      await control('/stop');
      for (let i = 0; i < 50 && alive(previous.pid); i++) await new Promise((r) => setTimeout(r, 100));
    }
    sandboxDir();
    const out = openSync(LOG, 'a');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ...rest], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const state = readState();
      if (state) {
        print({ ...(state.started as Row), ...(values['app-clock'] ? { app_clock: appClockSetup() } : {}) });
        return 0;
      }
    }
    print({ ok: false, code: 'start_failed', developer_message: `The sandbox did not start. See ${LOG}.` });
    return 1;
  }
  if (command === 'report') {
    const state = readState();
    const report = await control('/report', 'GET');
    if (report.ok && state) {
      const warnings: string[] = report.warnings ?? [];
      recordRun({
        started_at: state.started_at,
        fault: report.fault.name,
        reported_at: new Date().toISOString(),
        movements: (report.movements ?? []).length,
        fired: report.fault.fired,
        warnings: warnings.length,
        first_warnings: warnings.slice(0, 3),
      });
    }
    const coverage = faultCoverage(readRuns());
    const left = coverage.filter((c) => c.status !== 'no_warnings').map((c) => `${c.fault} (${c.status})`);
    print({
      ...report,
      faults_tested: {
        in_this_folder: coverage.map(({ fault, status, warnings }) => ({ fault, status, ...(warnings !== undefined ? { warnings } : {}) })),
        next_step: left.length
          ? `Not done yet: ${left.join(', ')}. rate_limit does not apply to onramps, nor provider_error to bank onramps. Fix this run's warnings and check its check_in_app items, then start again with the next fault.`
          : 'Every fault ran with no warnings. Check each run\'s check_in_app items in your database; gs.mjs build_check_acceptance shows the faults too.',
      },
    });
    return 0;
  }
  if (command === 'advance') {
    const hours = Number(values.hours);
    if (!(hours > 0 && hours <= 72)) return invalid('Give --hours between 0 and 72.');
    return print(await control(`/advance?${q({ hours: String(hours) })}`)), 0;
  }
  if (command === 'pay') return print(await control(`/pay?${q({ id: positionals[0] })}`)), 0;
  if (command === 'return') {
    if (!positionals[0]) return invalid('Give the id of a successful onramp, offramp or conversion.');
    return print(await control(`/return?${q({ id: positionals[0] })}`)), 0;
  }
  if (command === 'kyc') {
    const [action, customer] = positionals;
    if (!['approve', 'reject', 'start'].includes(action ?? '') || !customer) return invalid('Give approve, reject or start, then the customer id.');
    return print(await control(`/kyc?${q({ action, customer, retry: values.retry ? 'true' : undefined })}`)), 0;
  }
  if (command === 'deposit') {
    const [target, amount] = positionals;
    if (!target || !amount) return invalid('Give the deposit address (or its da_ or wcr_ id), then the amount.');
    return print(await control(`/deposit?${q({ target, amount })}`)), 0;
  }
  if (command === 'approve-access') {
    if (!positionals[0]) return invalid('Give the currency code, and --country for XAF or XOF.');
    return print(await control(`/approve-access?${q({ currency: positionals[0].toUpperCase(), country: values.country?.toUpperCase() })}`)), 0;
  }
  if (command === 'stop') {
    const state = readState();
    if (!state) return print({ ok: true, stopped: false }), 0;
    return print(await control('/stop')), 0;
  }
  print({ usage: USAGE, faults: FAULTS });
  return command ? 1 : 0;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error) => {
    print({ ok: false, code: 'script_error', developer_message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
