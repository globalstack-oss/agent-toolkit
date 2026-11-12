// Which faults an app folder was tested against. sandbox.mjs records each report in
// .globalstack-sandbox/runs.json, in the folder it runs from; gs.mjs build_check_acceptance reads it back.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Fault, FAULTS, faultsFor } from './faults.ts';

/** The sandbox keeps its files here, in the app's folder. The folder ignores itself in git. */
export const SANDBOX_DIR = '.globalstack-sandbox';

/** One sandbox start, as its latest report saw it. */
export interface SandboxRun {
  started_at: string;
  fault: Fault;
  reported_at: string;
  movements: number;
  /** Whether the fault happened during the run (a lost response needs an execute to drop). Missing in older runs. */
  fired?: boolean;
  warnings: number;
  first_warnings: string[];
}

/**
 * no_warnings: the fault happened, a payment ran and the report saw nothing wrong at the API. It is not proof: the
 * sandbox cannot see the app's own records (each fault's check_in_app says what to check there).
 */
export type FaultStatus = 'no_warnings' | 'warnings' | 'fault_not_triggered' | 'no_payment' | 'not_run';

export function sandboxDir(cwd = process.cwd()): string {
  const dir = resolve(cwd, SANDBOX_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n');
  }
  return dir;
}

const runsPath = (cwd?: string) => resolve(cwd ?? process.cwd(), SANDBOX_DIR, 'runs.json');

export function readRuns(cwd?: string): SandboxRun[] {
  const path = runsPath(cwd);
  if (!existsSync(path)) return [];
  try {
    const runs = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(runs) ? runs.filter((r) => FAULTS.includes(r?.fault)) : [];
  } catch {
    return [];
  }
}

/** Keeps the latest report of each start. */
export function recordRun(run: SandboxRun, cwd?: string): void {
  sandboxDir(cwd);
  const runs = readRuns(cwd).filter((r) => r.started_at !== run.started_at);
  writeFileSync(runsPath(cwd), `${JSON.stringify([...runs, run], null, 2)}\n`);
}

/**
 * Each fault that applies to the flow, from its latest start: no_warnings, warnings, fault_not_triggered (a payment
 * ran but the fault never happened), no_payment (started, but no money movement was made) or not_run.
 */
export function faultCoverage(runs: SandboxRun[], direction?: string, network?: string) {
  return faultsFor(direction, network).map((fault) => {
    const last = runs.filter((r) => r.fault === fault).sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1);
    const status: FaultStatus = !last ? 'not_run'
      : last.movements === 0 ? 'no_payment'
      : last.warnings > 0 ? 'warnings'
      : last.fired === false ? 'fault_not_triggered'
      : 'no_warnings';
    return { fault, status, ...(last ? { warnings: last.warnings, first_warnings: last.first_warnings, reported_at: last.reported_at } : {}) };
  });
}
