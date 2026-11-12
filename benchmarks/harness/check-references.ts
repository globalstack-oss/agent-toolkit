// The fast check (no agents): copies the plugin's CURRENT reference code into each reference app, then grades every
// app against every scenario. Fails if any scenario is not a pass. GS_CODE_DIR grades another copy of the code
// (for example the MCP kit's, gs-mcp skill/globalstack-best-practices/code).
//
//   node --experimental-strip-types benchmarks/harness/check-references.ts [--tasks ngn-bank-offramp,...]
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gradeBuild } from './grade.ts';
import { jobList } from './tasks.ts';

const JOBS = fileURLToPath(new URL('..', import.meta.url));
const CODE = process.env.GS_CODE_DIR ?? join(JOBS, '..', 'plugin', 'skills', 'globalstack-integration', 'code');
const { values } = parseArgs({ options: { tasks: { type: 'string' } } });
const failed: string[] = [];
for (const task of jobList(values.tasks)) {
  const dir = join(JOBS, task, 'reference');
  const starterFile = join(JOBS, task, 'STARTER');
  const starter = existsSync(starterFile) ? readFileSync(starterFile, 'utf8').trim() : 'sqlite';
  rmSync(join(dir, 'node_modules'), { force: true });
  symlinkSync(join(JOBS, 'starters', starter, 'node_modules'), join(dir, 'node_modules'));
  for (const f of readdirSync(CODE).filter((n) => n.endsWith('.ts'))) cpSync(join(CODE, f), join(dir, 'src', 'globalstack', f));
  const verdicts = await gradeBuild(dir, task);
  for (const v of verdicts) {
    console.log(`RESULT ${task} ${v.scenario} ${v.outcome} ${v.notes.join(' | ')}`);
    if (v.outcome !== 'pass') failed.push(`${task} ${v.scenario}: ${v.outcome} ${v.notes.join(' | ')}`);
  }
}
if (failed.length) {
  console.error(`\n${failed.length} scenario(s) did not pass:\n${failed.join('\n')}`);
  process.exit(1);
}
console.log('\nevery reference app passes every scenario');
