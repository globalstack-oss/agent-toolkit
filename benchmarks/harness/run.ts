// One full eval run: build, grade every build, report.
//
//   node --experimental-strip-types harness/run.ts --arms docs,mcp --tasks ngn-bank-offramp,kes-bank-offramp-returns --reps 5
//   node --experimental-strip-types harness/run.ts --grade-only        (re-grade existing builds)
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { buildName, collect, render } from './report.ts';
import { jobList } from './tasks.ts';

const OUT = process.env.EVAL_OUT ?? '/private/tmp/gs-eval-v2';
const HERE = new URL('.', import.meta.url).pathname;

function node(script: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(HERE, script), ...args], { stdio: 'inherit', env: { ...process.env, EVAL_OUT: OUT } });
    child.on('exit', resolve);
  });
}

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'docs,mcp' },
    /** Job names (or the old T1-T11); default: every job. */
    tasks: { type: 'string' },
    reps: { type: 'string', default: '5' },
    'first-rep': { type: 'string', default: '1' },
    // One builder at a time: builders share the machine, and their process cleanups can hit each other.
    concurrency: { type: 'string', default: '1' },
    'redo-unfinished': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    'grade-concurrency': { type: 'string', default: '4' },
    'grade-only': { type: 'boolean', default: false },
  },
});

if (!values['grade-only'] && !values['skip-build']) {
  await node('build.ts', [
    '--arms', values.arms!, '--tasks', jobList(values.tasks).join(','), '--reps', values.reps!, '--first-rep', values['first-rep']!,
    '--concurrency', values.concurrency!, ...(values['redo-unfinished'] ? ['--redo-unfinished'] : []),
  ]);
}

const builds = existsSync(join(OUT, 'builds')) ? readdirSync(join(OUT, 'builds')).sort() : [];
const queue = builds.filter((b) => !existsSync(join(OUT, 'builds', b, '.grade', 'verdicts.json')) || values['grade-only']);
const workers = Array.from({ length: Number(values['grade-concurrency']) }, async () => {
  for (let b = queue.shift(); b; b = queue.shift()) {
    const { task } = buildName(b);
    await node('grade.ts', ['--build', join(OUT, 'builds', b), '--task', task]);
  }
});
await Promise.all(workers);

const rows = collect(OUT);
writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
const md = render(rows);
writeFileSync(join(OUT, 'results.md'), md);
console.log(md);
