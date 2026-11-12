// Runs one build's app as real processes: `npm run setup` once, then `npm start`.
// Each process gets its own process group so a crash scenario can kill the whole tree at once.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, type WriteStream } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const CLOCK_PRELOAD = fileURLToPath(new URL('./clock.mjs', import.meta.url));
/** The same clock jump for a Python app: pyclock/sitecustomize.py, which Python imports from PYTHONPATH at startup. */
const PY_CLOCK_DIR = fileURLToPath(new URL('./pyclock', import.meta.url));

export interface AppEnv {
  buildDir: string;
  workDir: string;
  port: number;
  simUrl: string;
  secretKey: string;
  customerId: string;
  walletId: string;
  /** The https origin the app believes it is reachable at; the simulator maps it to the local port. */
  publicUrl: string;
  extraEnv?: Record<string, string>;
  /** The app's database: SQLite by default, or a fresh Postgres database per scenario. */
  dbKind?: 'sqlite' | 'postgres';
}

// ── Postgres for tasks that need it: one local cluster, one fresh database per scenario ──
// Override both in CI (Linux): EVAL_PG_BIN=/usr/lib/postgresql/16/bin, EVAL_PG_DIR=$RUNNER_TEMP/gs-eval-pg.
const PG_BIN = process.env.EVAL_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const PG_DIR = process.env.EVAL_PG_DIR ?? '/private/tmp/gs-eval-pg';
const PG_PORT = 54329;
const pgArgs = ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres'];

/** Starts the local cluster once (trust auth, local only). Safe to call from several graders. */
export function ensurePostgres(): void {
  const data = join(PG_DIR, 'data');
  if (!existsSync(join(data, 'PG_VERSION'))) {
    mkdirSync(PG_DIR, { recursive: true });
    try {
      execFileSync(join(PG_BIN, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync'], { stdio: 'ignore' });
    } catch {
      // another grader initialised it first
    }
  }
  try {
    execFileSync(join(PG_BIN, 'pg_isready'), pgArgs, { stdio: 'ignore' });
  } catch {
    try {
      // macOS: without a valid LC_ALL the postmaster refuses to start ("became multithreaded during startup").
      execFileSync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-o', `-p ${PG_PORT} -k ${PG_DIR} -c max_connections=400 -c fsync=off`, '-l', join(PG_DIR, 'log'), '-w', 'start'],
        { stdio: 'ignore', env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } });
    } catch {
      execFileSync(join(PG_BIN, 'pg_isready'), [...pgArgs, '-t', '20'], { stdio: 'ignore' });
    }
  }
}

function newPgDatabase(): string {
  const name = `gse_${randomBytes(6).toString('hex')}`;
  execFileSync(join(PG_BIN, 'createdb'), [...pgArgs, name], { stdio: 'ignore' });
  return `postgres://postgres@127.0.0.1:${PG_PORT}/${name}`;
}

const isPg = (ref: string) => ref.startsWith('postgres://');
const psql = (url: string, sql: string) =>
  execFileSync(join(PG_BIN, 'psql'), [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' });
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Creates the app's database with the task's existing tables and rows. */
export function prepareDb(path: string, schemaSql: string, rows: Record<string, Array<Record<string, string>>>): void {
  if (isPg(path)) {
    const inserts = Object.entries(rows).flatMap(([table, list]) =>
      list.map((row) => `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(lit).join(', ')});`));
    psql(path, [schemaSql, ...inserts].join('\n'));
    return;
  }
  const db = new DatabaseSync(path);
  db.exec(schemaSql);
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]!));
    }
  }
  db.close();
}

export function readRows(dbPath: string, sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
  if (isPg(dbPath)) {
    let i = 0;
    const bound = sql.replace(/\?/g, () => (typeof params[i] === 'number' ? String(params[i++]) : lit(String(params[i++]))));
    return JSON.parse(psql(dbPath, `SELECT coalesce(json_agg(t), '[]'::json) FROM (${bound}) t`).trim() || '[]');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export class App {
  readonly env: AppEnv;
  readonly dbPath: string;
  readonly clockFile: string;
  private proc: ChildProcess | null = null;
  private log: WriteStream;
  private starts = 0;

  constructor(env: AppEnv) {
    this.env = env;
    mkdirSync(env.workDir, { recursive: true });
    this.dbPath = env.dbKind === 'postgres' ? newPgDatabase() : join(env.workDir, 'app.db');
    this.clockFile = join(env.workDir, 'clock');
    this.log = createWriteStream(join(env.workDir, 'app.log'), { flags: 'a' });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.env.port}`;
  }

  /** A short temp dir: macOS caps Unix socket paths (tsx uses one) at 104 bytes. */
  private readonly tmp = mkdtempSync('/tmp/gse-');

  private processEnv(): NodeJS.ProcessEnv {
    const e = this.env;
    return {
      PATH: process.env.PATH,
      HOME: e.workDir,
      TMPDIR: this.tmp,
      NODE_ENV: 'production',
      PORT: String(e.port),
      ...(isPg(this.dbPath) ? { DATABASE_URL: this.dbPath } : { DATABASE_PATH: this.dbPath }),
      PUBLIC_URL: e.publicUrl,
      GLOBALSTACK_BASE_URL: e.simUrl,
      GLOBALSTACK_SECRET_KEY: e.secretKey,
      GLOBALSTACK_CUSTOMER_ID: e.customerId,
      GLOBALSTACK_WALLET_ID: e.walletId,
      EVAL_CLOCK_FILE: this.clockFile,
      NODE_OPTIONS: `--import ${CLOCK_PRELOAD} --no-warnings`,
      PYTHONPATH: PY_CLOCK_DIR,
      ...e.extraEnv,
    };
  }

  private spawnNpm(script: string): ChildProcess {
    const child = spawn('npm', ['run', '--silent', script], {
      cwd: this.env.buildDir,
      env: this.processEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => this.log.write(d));
    child.stderr!.on('data', (d) => this.log.write(d));
    return child;
  }

  /** `npm run setup`, once. Resolves with its exit code (null on timeout). */
  setup(timeoutMs = 60_000): Promise<number | null> {
    this.log.write('\n===== npm run setup\n');
    const child = this.spawnNpm('setup');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        killGroup(child);
        resolve(null);
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /** `npm start`, then waits until the port accepts connections. */
  async start(timeoutMs = 60_000): Promise<boolean> {
    this.starts += 1;
    this.log.write(`\n===== npm start (#${this.starts})\n`);
    this.proc = this.spawnNpm('start');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) return false;
      if (await portOpen(this.env.port)) return true;
      await sleep(100);
    }
    return false;
  }

  /** Kills the whole process tree at once, like a crash. */
  crash(): void {
    if (this.proc) killGroup(this.proc);
    this.proc = null;
    this.log.write('\n===== killed (crash)\n');
  }

  async stop(): Promise<void> {
    if (this.proc) {
      killGroup(this.proc);
      this.proc = null;
    }
    await sleep(50);
  }

  close(): void {
    this.log.end();
  }

  /** Calls the app's own HTTP interface. Never throws: a dead app answers status 0. */
  async call(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; json: any; text: string }> {
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, json, text };
    } catch (error) {
      return { status: 0, json: null, text: String(error) };
    }
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
