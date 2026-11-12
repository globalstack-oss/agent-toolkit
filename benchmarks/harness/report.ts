// Turns graded builds into the results: unsafe builds per arm with an interval, per task, per scenario,
// plus cost and usage from the transcripts.
//
//   node --experimental-strip-types harness/report.ts [--out /private/tmp/gs-eval-v2]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Verdict } from './grade.ts';

// A path in the home folder, other than the builder's own session files under ~/.claude/projects.
const HOME_RE = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OUTSIDE = new RegExp(`${HOME_RE}/(?!\\.claude/projects/)`);

export interface BuildResult {
  build: string;
  arm: string;
  task: string;
  rep: number;
  outcome: 'unsafe' | 'incomplete' | 'pass' | 'not-run';
  scenarios: Verdict[];
  costUsd: number | null;
  minutes: number | null;
  toolCalls: number;
  guidanceCalls: number;
  /** Plugin arms: which plugin skills the agent loaded, and the sandbox faults it started (from its commands). */
  skills: string[];
  sandboxFaults: string[];
  isolation: string[];
  /** Tokens the builder read (fresh + cached) and wrote, and its turns. */
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number | null;
  /** Calls per GlobalStack MCP tool, and the ones that came back as errors. */
  mcpCalls: Record<string, number>;
  mcpErrors: Record<string, number>;
}

// Every job in benchmarks/ has been built against the plugin (runs of 14 to 20 Oct), so none is held out here.
// New held-out jobs stay outside this repository; add their names here when a run grades them.
const HELD_OUT = new Set<string>();

/** A build folder is <arm>-<job>-<rep>; job names have dashes, arms do not. */
export function buildName(name: string): { arm: string; task: string; rep: number } {
  const parts = name.split('-');
  return { arm: parts[0]!, task: parts.slice(1, -1).join('-'), rep: Number(parts.at(-1)) };
}

type Usage = Pick<BuildResult, 'costUsd' | 'minutes' | 'toolCalls' | 'guidanceCalls' | 'skills' | 'sandboxFaults' | 'isolation' | 'tokensIn' | 'tokensOut' | 'turns' | 'mcpCalls' | 'mcpErrors'>;
const MCP_PREFIX = 'mcp__globalstack__';
const SANDBOX_FAULTS = ['lost_response', 'provider_error', 'rate_limit', 'webhook_silence', 'webhook_noise', 'slow_final'];

function usage(dir: string): Usage {
  const out: Usage = { costUsd: null, minutes: null, toolCalls: 0, guidanceCalls: 0, skills: [], sandboxFaults: [], isolation: [], tokensIn: null, tokensOut: null, turns: null, mcpCalls: {}, mcpErrors: {} };
  const toolNames = new Map<string, string>();
  const path = join(dir, '.transcript.jsonl');
  if (!existsSync(path)) return out;
  const arm = dir.split('/').pop()!.split('-')[0];
  const sandboxScripts = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex (`codex exec --json`): usage on turn.completed, one item per tool call. No cost or duration in the stream.
    if (msg.type === 'turn.completed') {
      const u = msg.usage ?? {};
      out.tokensIn = u.input_tokens ?? null;
      out.tokensOut = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
    }
    if (msg.type === 'item.completed' && msg.item?.type === 'agent_message') out.turns = (out.turns ?? 0) + 1;
    if (msg.type === 'item.completed' && (msg.item?.type === 'mcp_tool_call' || msg.item?.type === 'command_execution')) {
      out.toolCalls += 1;
      const it = msg.item;
      if (it.type === 'mcp_tool_call' && it.server === 'globalstack') {
        out.mcpCalls[it.tool] = (out.mcpCalls[it.tool] ?? 0) + 1;
        if (it.tool === 'build_guidance') out.guidanceCalls += 1;
        if (it.error || it.result?.is_error) out.mcpErrors[it.tool] = (out.mcpErrors[it.tool] ?? 0) + 1;
      }
      const cmd = it.type === 'command_execution' ? String(it.command ?? '') : '';
      if (/\b(curl|wget)\b[^\n]*api\.globalstack\.io/.test(cmd)) out.isolation.push('shell called api.globalstack.io');
      if (arm === 'mcp' && /\b(curl|wget)\b[^\n]*https?:\/\/(?!127\.0\.0\.1|localhost)/.test(cmd)) out.isolation.push('shell read the web');
      continue;
    }
    // A build that waits on its own background work ends in several results, one per resumed turn. The cost is
    // a running total; tokens and turns are per result, so they add up.
    if (msg.type === 'result') {
      out.costUsd = msg.total_cost_usd ?? null;
      const u = msg.usage ?? {};
      out.tokensIn = (out.tokensIn ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      out.tokensOut = (out.tokensOut ?? 0) + (u.output_tokens ?? 0);
      out.turns = (out.turns ?? 0) + (msg.num_turns ?? 0);
    }
    if (msg.type === 'user') {
      for (const c of msg.message?.content ?? []) {
        const name = c?.type === 'tool_result' ? toolNames.get(c.tool_use_id) : undefined;
        if (name && c.is_error) out.mcpErrors[name] = (out.mcpErrors[name] ?? 0) + 1;
        // Builders often start the sandbox from a script of their own: its start and report answers name the fault.
        if (c?.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x?.text ?? '').join('');
        for (const f of SANDBOX_FAULTS) {
          if (new RegExp(`"name":\\s*"${f}",\\s*"what_happens"`).test(text) && !out.sandboxFaults.includes(f)) out.sandboxFaults.push(f);
        }
      }
    }
    if (msg.type !== 'assistant') continue;
    for (const c of msg.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      out.toolCalls += 1;
      if (c.name === 'mcp__globalstack__build_guidance') out.guidanceCalls += 1;
      if (c.name === 'Bash' && /gs\.mjs[^\n]*build_guidance/.test(String(c.input?.command ?? ''))) out.guidanceCalls += 1;
      if (c.name === 'Skill' && c.input?.skill && !out.skills.includes(String(c.input.skill))) out.skills.push(String(c.input.skill));
      const bash = c.name === 'Bash' ? String(c.input?.command ?? '') : '';
      // A script the builder wrote that starts the sandbox (run.sh, fault.sh): a later command passing it a fault runs it.
      const written = c.name === 'Write' ? [[String(c.input?.file_path ?? ''), String(c.input?.content ?? '')]] : [...bash.matchAll(/cat\s+>\s*(\S+)\s+<<-?\s*'?(\w+)'?\n([\s\S]*?)\n\2\b/g)].map((m) => [m[1]!, m[3]!]);
      for (const [file, body] of written) if (/sandbox\.mjs/.test(body!) && /\bstart\b/.test(body!)) sandboxScripts.add(file!.split('/').pop()!.replace(/^\$\w+\//, ''));
      const startsSandbox = (/sandbox\.mjs/.test(bash) && /\bstart\b/.test(bash)) || [...sandboxScripts].some((f) => bash.includes(f));
      if (startsSandbox) {
        for (const f of SANDBOX_FAULTS) {
          if (new RegExp(`\\b${f}\\b`).test(bash) && !out.sandboxFaults.includes(f)) out.sandboxFaults.push(f);
        }
      }
      if (String(c.name).startsWith(MCP_PREFIX)) {
        const tool = c.name.slice(MCP_PREFIX.length);
        toolNames.set(c.id, tool);
        out.mcpCalls[tool] = (out.mcpCalls[tool] ?? 0) + 1;
      }
      // Isolation: nobody calls the real API; the MCP arm never reads the web; nobody reads outside the build.
      const url = String(c.input?.url ?? '');
      const cmd = c.name === 'Bash' ? String(c.input?.command ?? '') : '';
      const path = String(c.input?.file_path ?? c.input?.path ?? '');
      if (/^https?:\/\/api\.globalstack\.io([/:?#]|$)/.test(url) || /\b(curl|wget)\b[^\n]*api\.globalstack\.io/.test(cmd)) out.isolation.push(`${c.name} called api.globalstack.io`);
      if ((arm === 'mcp' || arm === 'plugin' || arm === 'neutral' || arm === 'neutralpy') && (c.name === 'WebFetch' || /\b(curl|wget)\b[^\n]*https?:\/\/(?!127\.0\.0\.1|localhost)/.test(cmd))) out.isolation.push(`${c.name} read the web`);
      // The builder's own session files (large tool results) live under ~/.claude/projects/<its folder>: allowed.
      if ((['Read', 'Glob', 'Grep'].includes(c.name) && OUTSIDE.test(path)) || new RegExp(`\\b(cat|ls|find|grep|head|tail)\\b[^\\n]*${HOME_RE}/`).test(cmd) && OUTSIDE.test(cmd)) out.isolation.push(`${c.name} looked outside its folder`);
      // Plugin arm: the bundled scripts carry the failure sandbox's code, which is close to the grader's simulator.
      // Builders often put the script path in a shell variable first (S=.../gs.mjs; grep ... $S), so follow those.
      const scriptVars = [...cmd.matchAll(/\b([A-Za-z_]\w*)=\S*\b(?:gs|sandbox)\.mjs\b/g)].map((m) => `\\$\\{?${m[1]}\\b`);
      const scriptFile = new RegExp(`\\b(cat|sed|grep|head|tail|less|awk|strings)\\b[^\\n|;&]*(\\b(gs|sandbox)\\.mjs${scriptVars.map((v) => `|${v}`).join('')})`);
      if ((arm === 'plugin' || arm === 'neutral' || arm === 'neutralpy') && ((['Read', 'Grep'].includes(c.name) && /\.mjs$|scripts\/?$/.test(path)) || scriptFile.test(cmd))) out.isolation.push(`${c.name} read the script source`);
      // Linux runs: the eval repo (tasks, simulator, graders) sits next to the plugin. Reading it is a leak.
      if (/\/home\/claude\/gs-mcp\b/.test(path) || /\/home\/claude\/gs-mcp\b/.test(cmd)) out.isolation.push(`${c.name} read the eval repo`);
    }
  }
  // Wall time, from the prompt the harness wrote before the agent started to the transcript it saved at exit. A
  // result's duration_ms leaves out the time the agent spent waiting on its own background work.
  const prompt = join(dir, '.prompt');
  if (existsSync(prompt)) out.minutes = Math.round((statSync(path).mtimeMs - statSync(prompt).mtimeMs) / 6000) / 10;
  return out;
}

export function collect(outDir: string): BuildResult[] {
  const root = join(outDir, 'builds');
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map((name) => {
    const dir = join(root, name);
    const { arm, task, rep } = buildName(name);
    const verdictsPath = join(dir, '.grade', 'verdicts.json');
    const scenarios: Verdict[] = existsSync(verdictsPath) ? JSON.parse(readFileSync(verdictsPath, 'utf8')) : [];
    const outcome: BuildResult['outcome'] = !scenarios.length
      ? 'not-run'
      : scenarios.some((s) => s.outcome === 'unsafe')
        ? 'unsafe'
        : scenarios.every((s) => s.outcome === 'pass')
          ? 'pass'
          : 'incomplete';
    return { build: name, arm, task, rep, outcome, scenarios, ...usage(dir) };
  });
}

/** Seeded resampling, so a report is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** 90% interval of unsafe(b) − unsafe(a), resampling builds within each task. */
function gapInterval(rows: BuildResult[], a: string, b: string): [number, number] | null {
  const tasks = [...new Set(rows.map((r) => r.task))];
  const cell = (arm: string, task: string) => rows.filter((r) => r.arm === arm && r.task === task && r.outcome !== 'not-run').map((r) => (r.outcome === 'unsafe' ? 1 : 0));
  if (tasks.some((t) => !cell(a, t).length || !cell(b, t).length)) return null;
  const rand = rng(7);
  const draws: number[] = [];
  for (let i = 0; i < 4000; i++) {
    let ua = 0;
    let na = 0;
    let ub = 0;
    let nb = 0;
    for (const t of tasks) {
      for (const [arm, add] of [[a, (x: number) => { ua += x; na += 1; }], [b, (x: number) => { ub += x; nb += 1; }]] as const) {
        const xs = cell(arm, t);
        for (let k = 0; k < xs.length; k++) add(xs[Math.floor(rand() * xs.length)]!);
      }
    }
    draws.push(ub / nb - ua / na);
  }
  draws.sort((x, y) => x - y);
  return [draws[Math.floor(0.05 * draws.length)]!, draws[Math.floor(0.95 * draws.length)]!];
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '·');

export function render(rows: BuildResult[]): string {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const lines: string[] = ['# Eval v2 results', ''];
  lines.push('| Arm | Unsafe builds | Incomplete | Pass | Not run | Median $ | Median min | build_guidance called |', '| - | - | - | - | - | - | - | - |');
  const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN);
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const ran = rs.filter((r) => r.outcome !== 'not-run');
    const count = (o: string) => rs.filter((r) => r.outcome === o).length;
    const guidance = arm === 'mcp' || arm === 'plugin' || arm === 'neutral' || arm === 'neutralpy' ? `${rs.filter((r) => r.guidanceCalls > 0).length}/${rs.length}` : '·';
    lines.push(`| ${arm} | ${count('unsafe')}/${ran.length} (${pct(count('unsafe'), ran.length)}) | ${count('incomplete')} | ${count('pass')} | ${count('not-run')} | ${median(rs.map((r) => r.costUsd ?? NaN).filter((x) => !Number.isNaN(x))).toFixed(2)} | ${median(rs.map((r) => r.minutes ?? NaN).filter((x) => !Number.isNaN(x)))} | ${guidance} |`);
  }
  const pluginArms = arms.filter((a) => a === 'plugin' || a === 'neutral' || a === 'neutralpy');
  if (pluginArms.length) {
    lines.push('', '## Plugin use', '', '| Arm | Integration skill loaded | Testing skill loaded | Builds that started a failure fault | Builds that ran all 6 faults |', '| - | - | - | - | - |');
    for (const arm of pluginArms) {
      const rs = rows.filter((r) => r.arm === arm);
      const n = (f: (r: BuildResult) => boolean) => `${rs.filter(f).length}/${rs.length}`;
      lines.push(`| ${arm} | ${n((r) => r.skills.some((k) => k.includes('integration')))} | ${n((r) => r.skills.some((k) => k.includes('testing')))} | ${n((r) => r.sandboxFaults.length > 0)} | ${n((r) => r.sandboxFaults.length >= 6)} |`);
    }
  }
  if (arms.includes('docs') && arms.includes('mcp')) {
    const gap = gapInterval(rows, 'docs', 'mcp');
    if (gap) lines.push('', `Gap in unsafe-build rate, MCP minus docs: 90% interval ${Math.round(gap[0] * 100)} to ${Math.round(gap[1] * 100)} points (negative = MCP safer).`);
  }
  lines.push('', '## Per task (unsafe / incomplete / pass)', '', `| Task | ${arms.join(' | ')} |`, `| - | ${arms.map(() => '-').join(' | ')} |`);
  for (const task of tasks) {
    const cells = arms.map((arm) => {
      const rs = rows.filter((r) => r.arm === arm && r.task === task);
      return `${rs.filter((r) => r.outcome === 'unsafe').length} / ${rs.filter((r) => r.outcome === 'incomplete' || r.outcome === 'not-run').length} / ${rs.filter((r) => r.outcome === 'pass').length}`;
    });
    lines.push(`| ${task}${HELD_OUT.has(task) ? ' (held out)' : ''} | ${cells.join(' | ')} |`);
  }
  const scenarios = [...new Set(rows.flatMap((r) => r.scenarios.map((s) => s.scenario)))];
  lines.push('', '## Per scenario: unsafe runs (incomplete runs)', '', `| Scenario | ${arms.join(' | ')} |`, `| - | ${arms.map(() => '-').join(' | ')} |`);
  for (const sc of scenarios) {
    const cells = arms.map((arm) => {
      const vs = rows.filter((r) => r.arm === arm).flatMap((r) => r.scenarios.filter((s) => s.scenario === sc));
      return `${vs.filter((v) => v.outcome === 'unsafe').length} (${vs.filter((v) => v.outcome === 'incomplete' || v.outcome === 'broken').length}) of ${vs.length}`;
    });
    lines.push(`| ${sc} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Usage per build (median)', '', '| Arm | Tokens read | Tokens written | Turns | Tool calls | MCP calls | MCP errors |', '| - | - | - | - | - | - | - |');
  const med = (xs: Array<number | null>) => {
    const ys = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)]! : NaN;
  };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    lines.push(`| ${arm} | ${Math.round(med(rs.map((r) => r.tokensIn)) / 1000)}k | ${Math.round(med(rs.map((r) => r.tokensOut)) / 1000)}k | ${med(rs.map((r) => r.turns))} | ${med(rs.map((r) => r.toolCalls))} | ${med(rs.map((r) => sum(r.mcpCalls)))} | ${med(rs.map((r) => sum(r.mcpErrors)))} |`);
  }
  const tools = [...new Set(rows.flatMap((r) => Object.keys(r.mcpCalls)))].sort();
  if (tools.length) {
    lines.push('', '## MCP tools: calls (errors), and builds that used each', '', '| Tool | Calls | Errors | Builds |', '| - | - | - | - |');
    for (const t of tools) {
      const using = rows.filter((r) => r.mcpCalls[t]);
      lines.push(`| ${t} | ${sum(Object.fromEntries(rows.map((r) => [r.build, r.mcpCalls[t] ?? 0])))} | ${sum(Object.fromEntries(rows.map((r) => [r.build, r.mcpErrors[t] ?? 0])))} | ${using.length}/${rows.filter((r) => r.arm === 'mcp').length} |`);
    }
  }
  const breaches = rows.filter((r) => r.isolation.length);
  if (breaches.length) {
    lines.push('', '## Isolation breaches', '');
    for (const r of breaches) lines.push(`- ${r.build}: ${[...new Set(r.isolation)].join('; ')}`);
  }
  lines.push('', '## Unsafe findings', '');
  for (const r of rows.filter((x) => x.outcome === 'unsafe')) {
    for (const s of r.scenarios.filter((x) => x.outcome === 'unsafe')) lines.push(`- ${r.build} · ${s.scenario}: ${s.notes.join(' | ')}`);
  }
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: process.env.EVAL_OUT ?? '/private/tmp/gs-eval-v2' } } });
  const rows = collect(values.out!);
  writeFileSync(join(values.out!, 'results.json'), JSON.stringify(rows, null, 1));
  const md = render(rows);
  writeFileSync(join(values.out!, 'results.md'), md);
  // Every builder writes NOTES.md (assumptions, open questions for GlobalStack): collect them for review.
  const notes = rows.map((r) => {
    const path = join(values.out!, 'builds', r.build, 'NOTES.md');
    return `# ${r.build} (${r.outcome})\n\n${existsSync(path) ? readFileSync(path, 'utf8').trim() : '_no NOTES.md_'}\n`;
  });
  writeFileSync(join(values.out!, 'builder-notes.md'), notes.join('\n'));
  console.log(md);
}
