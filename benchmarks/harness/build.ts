// Builds: one isolated coding-agent session per (arm, task, rep), with `claude -p`.
//
//   node --experimental-strip-types harness/build.ts --arms docs,mcp --tasks ngn-bank-offramp,zar-bank-onramp --reps 5 --concurrency 6
//
// Each build starts from starters/sqlite/ (or the starter named in <job>/STARTER) in its own folder under $EVAL_OUT (default /private/tmp/gs-eval-v2).
// The agent never sees the simulator's faults, the scenarios or the grader.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSnapshotServer } from './snapshot-server.ts';
import { jobList } from './tasks.ts';

/** benchmarks/: one folder per job, next to harness/, prompt/ and starters/. */
const JOBS = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(JOBS, '..');
/** The MCP arms need a gs-mcp checkout with a built server (dist/index.js). */
const MCP_REPO = process.env.EVAL_MCP_DIR ?? join(REPO, '..', 'gs-mcp');
const OUT = process.env.EVAL_OUT ?? '/private/tmp/gs-eval-v2';
const SIM_KEY = 'gsa_sk_live_eval_simulator_key_000000000000';
/** The plugin arm loads this folder with --plugin-dir. Point it at a frozen copy so work on the plugin cannot change a run. */
const PLUGIN_DIR = process.env.EVAL_PLUGIN_DIR ?? join(REPO, 'plugin');

const READ_TOOLS = [
  'get_gs_account_info', 'search_docs', 'list_supported_routes', 'get_rate', 'get_customer', 'get_wallet',
  'list_beneficiaries', 'get_quote', 'get_transaction', 'get_webhooks', 'validate_payout_details',
  'build_guidance', 'build_check_acceptance', 'get_reference_code',
  'sandbox_start', 'sandbox_report', 'sandbox_advance', 'sandbox_stop',
];
const WRITE_TOOLS = [
  'create_customer', 'update_customer', 'start_verification', 'create_beneficiary', 'update_beneficiary',
  'deactivate_beneficiary', 'create_wallet', 'update_wallet', 'create_credential', 'deactivate_credential',
  'create_deposit_address', 'deactivate_deposit_address', 'request_currency_access', 'create_quote',
  'manage_webhook', 'execute_onramp', 'execute_offramp', 'execute_conversion', 'execute_transfer',
];

const SOURCES: Record<string, string> = {
  docs: 'Your only source of information about GlobalStack is its public documentation at https://docs.globalstack.io/llms-full.txt (fetch it with WebFetch or `curl -s`). Do not call the GlobalStack API.',
  mcp: 'Your only source of information about GlobalStack is the GlobalStack MCP server (its tools are already connected). Do not fetch any web page. Use only its read tools; never create, change or pay anything.',
  plugin: `Your only source of information about GlobalStack is the globalstack plugin: its skills (globalstack-integration, globalstack-testing) are installed, and its files are in ${PLUGIN_DIR}. Do not fetch any web page. Run its scripts, but do not read their source (the .mjs files): use them as tools. Its scripts only read; never create, change or pay anything yourself.`,
  // A merchant's real prompt: no hint that a plugin is installed or what it is called. Only the web stays off, for isolation.
  neutral: 'Do not fetch any web page.',
  // The same merchant prompt, in a Python app (starters/python, prompt/common-py.md).
  neutralpy: 'Do not fetch any web page.',
  skill: 'Your sources of information about GlobalStack are CLAUDE.md in this folder (the vendor\'s integration rules: follow them) and the public documentation at https://docs.globalstack.io/llms-full.txt (fetch it with WebFetch or `curl -s`). Do not call the GlobalStack API.',
};

export interface BuildSpec {
  arm: 'docs' | 'mcp' | 'skill' | 'plugin' | 'neutral' | 'neutralpy';
  task: string;
  rep: number;
}

/** Arms that load the plugin: `plugin` names it in the prompt, `neutral` and `neutralpy` (a Python app) do not. */
const usesPlugin = (arm: BuildSpec['arm']) => arm === 'plugin' || arm === 'neutral' || arm === 'neutralpy';
const isPython = (arm: BuildSpec['arm']) => arm === 'neutralpy';

export function buildDir(b: BuildSpec): string {
  return join(OUT, 'builds', `${b.arm}-${b.task}-${b.rep}`);
}

function prompt(b: BuildSpec): string {
  const common = readFileSync(join(JOBS, 'prompt', isPython(b.arm) ? 'common-py.md' : 'common.md'), 'utf8');
  const task = readFileSync(join(JOBS, b.task, 'task.md'), 'utf8');
  return [
    'You are simulating an outside developer\'s coding agent integrating a third-party payments API.',
    `Isolation rules (strict): ${SOURCES[b.arm]} Do not read, search or list anything outside your current folder${b.arm === 'plugin' ? ' and the plugin folder' : b.arm === 'neutral' || b.arm === 'neutralpy' ? ', except files your installed skills point you to' : ''}. Do not install packages. Do not mention in code or notes which sources you used.`,
    '',
    common.trim(),
    task.trim().includes('GLOBALSTACK_NGN_WALLET_ID') ? '  - `GLOBALSTACK_NGN_WALLET_ID`: our NGN wallet at GlobalStack' : '',
    '',
    task.trim(),
    '',
    'When done, reply with one line: the list of files you wrote.',
  ].join('\n');
}

/** The starter app a build starts from, in starters/: `sqlite` unless <job>/STARTER names another (`postgres`); Python arms use `python`. */
function starterOf(b: BuildSpec): string {
  if (isPython(b.arm)) return 'python';
  const task = b.task;
  const file = join(JOBS, task, 'STARTER');
  if (!existsSync(file)) return 'sqlite';
  const name = readFileSync(file, 'utf8').trim();
  if (!['sqlite', 'postgres'].includes(name)) throw new Error(`benchmarks/${task}/STARTER: unknown starter '${name}'`);
  return name;
}

function prepare(b: BuildSpec, mcpUrl: string | null): string {
  const dir = buildDir(b);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'db'), { recursive: true });
  const starter = join(JOBS, 'starters', starterOf(b));
  // Installed packages are shared, not copied: node_modules for Node starters, .venv for Python.
  const shared = ['node_modules', '.venv'];
  cpSync(starter, dir, { recursive: true, filter: (src) => !shared.some((d) => src.includes(d)) });
  for (const d of shared) if (existsSync(join(starter, d))) symlinkSync(join(starter, d), join(dir, d));
  cpSync(join(JOBS, b.task, 'schema.sql'), join(dir, 'db', 'schema.sql'));
  writeFileSync(join(dir, '.prompt'), prompt(b));
  if (b.arm === 'skill') {
    cpSync(join(MCP_REPO, 'skill', 'globalstack-best-practices', 'SKILL.md'), join(dir, 'CLAUDE.md'));
  }
  const servers = b.arm === 'mcp' && mcpUrl
    ? {
        globalstack: {
          command: 'node',
          // EVAL_MCP_DIR pins a frozen copy of the server, so work on the repo cannot change a run.
          args: [join(MCP_REPO, 'dist', 'index.js')],
          env: { GLOBALSTACK_API_KEY: SIM_KEY, GLOBALSTACK_API_BASE_URL: mcpUrl },
        },
      }
    : {};
  writeFileSync(join(dir, '.mcp-eval.json'), JSON.stringify({ mcpServers: servers }));
  return dir;
}

function claudeArgs(b: BuildSpec, dir: string): string[] {
  // Absolute paths (`//abs/**`): a `./**` rule follows the shell's cwd, so a builder that ran `cd src/globalstack`
  // was refused every write outside that folder.
  const files = ['Glob', 'Grep', ...['Read', 'Write', 'Edit'].map((t) => `${t}(/${dir}/**)`)];
  const pluginFiles = ['Read', 'Glob', 'Grep'].map((t) => `${t}(/${PLUGIN_DIR}/**)`);
  const allowed = b.arm === 'mcp'
    ? [...files, 'Bash', ...READ_TOOLS.map((t) => `mcp__globalstack__${t}`)]
    : usesPlugin(b.arm)
      ? [...files, ...pluginFiles, 'Bash', 'Skill']
      : [...files, 'Bash', 'WebFetch(domain:docs.globalstack.io)'];
  const denied = b.arm === 'mcp' || usesPlugin(b.arm)
    ? ['WebSearch', 'WebFetch', ...WRITE_TOOLS.map((t) => `mcp__globalstack__${t}`)]
    : ['WebSearch'];
  // The prompt goes in on stdin, never in argv: a builder's `pkill -f src/server.ts` must not match
  // the other builders' command lines (that killed half of the first full run).
  return [
    '-p',
    '--model', process.env.EVAL_MODEL ?? 'opus',
    '--strict-mcp-config', '--mcp-config', join(dir, '.mcp-eval.json'),
    '--tools', b.arm === 'mcp' ? 'Read,Write,Edit,Glob,Grep,Bash' : usesPlugin(b.arm) ? 'Read,Write,Edit,Glob,Grep,Bash,Skill' : 'Read,Write,Edit,Glob,Grep,Bash,WebFetch',
    // The plugin arm loads the plugin; its skills need slash commands on, so it skips --disable-slash-commands.
    ...(usesPlugin(b.arm) ? ['--plugin-dir', PLUGIN_DIR] : []),
    '--allowedTools', ...allowed,
    '--disallowedTools', ...denied,
    // No user settings: the builder gets no personal hooks, plugins or permission rules, only what is listed here.
    '--setting-sources', 'project,local',
    // File edits inside the build are pre-approved: without it, -p sometimes refused a write halfway through.
    '--permission-mode', 'acceptEdits',
    ...(usesPlugin(b.arm) ? [] : ['--disable-slash-commands']), '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose',
  ];
}

/** Which coding agent builds: Claude Code (default) or the Codex CLI, logged in on this machine. */
const AGENT = process.env.EVAL_AGENT ?? 'claude';

/**
 * Codex: no user config (no personal MCP servers or plugins), no ChatGPT connectors, nothing saved, writes only inside the build, the
 * same GlobalStack MCP server as Claude. Codex has no per-tool allow list: the prompt's isolation rules apply,
 * and the server's write tools refuse anything without a person's confirmation.
 */
function codexArgs(dir: string): string[] {
  const server = JSON.parse(readFileSync(join(dir, '.mcp-eval.json'), 'utf8')).mcpServers.globalstack;
  const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-C', dir, '--sandbox', 'workspace-write',
    '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true',
    // No ChatGPT connectors (Gmail, Drive...): a builder must only see the GlobalStack MCP.
    '-c', 'features.apps=false'];
  if (server) {
    // Codex starts MCP servers with a minimal environment: give it the full path to node.
    const command = server.command === 'node' ? process.execPath : server.command;
    args.push('-c', `mcp_servers.globalstack.command=${JSON.stringify(command)}`, '-c', `mcp_servers.globalstack.args=${JSON.stringify(server.args)}`,
      '-c', `mcp_servers.globalstack.env={GLOBALSTACK_API_KEY=${JSON.stringify(server.env.GLOBALSTACK_API_KEY)},GLOBALSTACK_API_BASE_URL=${JSON.stringify(server.env.GLOBALSTACK_API_BASE_URL)}}`);
  }
  if (process.env.EVAL_MODEL) args.push('-m', process.env.EVAL_MODEL);
  args.push('-'); // the prompt comes on stdin
  return args;
}

/** Set when the agent's plan runs out (Codex "usage limit"): the queue stops, so no build starts only to fail at once. */
let outOfQuota = false;
/** A build counts as finished when the agent wrote its final line: Claude's `result`, Codex's `turn.completed`. */
const FINISHED = AGENT === 'codex' ? '"type":"turn.completed"' : '"type":"result"';

function runOne(b: BuildSpec, mcpUrl: string | null): Promise<void> {
  const dir = prepare(b, mcpUrl);
  return new Promise((resolve) => {
    const [cmd, args] = AGENT === 'codex' ? ['codex', codexArgs(dir)] : ['claude', claudeArgs(b, dir)];
    // The plugin's scripts read the key and base URL from the environment: point them at the snapshot server.
    const env = usesPlugin(b.arm) && mcpUrl ? { ...process.env, GLOBALSTACK_API_KEY: SIM_KEY, GLOBALSTACK_API_BASE_URL: mcpUrl } : process.env;
    const child = spawn(cmd, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(readFileSync(join(dir, '.prompt'), 'utf8'));
    const transcript: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (d) => transcript.push(d));
    child.stderr.on('data', (d) => errors.push(d));
    child.on('exit', (code) => {
      writeFileSync(join(dir, '.transcript.jsonl'), Buffer.concat(transcript));
      writeFileSync(join(dir, '.stderr'), Buffer.concat(errors).toString() + (code ? `\nexit ${code}` : ''));
      if (Buffer.concat(transcript).includes('usage limit')) outOfQuota = true;
      console.log(`built ${b.arm}-${b.task}-${b.rep} (exit ${code})${outOfQuota ? ': the plan hit its usage limit, stopping' : ''}`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arms: { type: 'string', default: 'docs,mcp' },
      /** Job names (or the old T1-T11); default: every job. */
      tasks: { type: 'string' },
      reps: { type: 'string', default: '5' },
      'first-rep': { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '1' },
      /** Rebuild only builds that did not finish (killed, or no result line). */
      'redo-unfinished': { type: 'boolean', default: false },
    },
  });
  const arms = values.arms!.split(',') as BuildSpec['arm'][];
  const tasks = jobList(values.tasks);
  const first = Number(values['first-rep']);
  const reps = Number(values.reps);
  const queue: BuildSpec[] = [];
  for (let rep = first; rep < first + reps; rep++) for (const task of tasks) for (const arm of arms) queue.push({ arm, task, rep });
  if (values['redo-unfinished']) {
    const finished = (b: BuildSpec) => {
      const path = join(buildDir(b), '.transcript.jsonl');
      return existsSync(path) && readFileSync(path, 'utf8').includes(FINISHED);
    };
    queue.splice(0, queue.length, ...queue.filter((b) => !finished(b)));
    console.log(`rebuilding ${queue.length} unfinished builds`);
  }

  const snapshot = arms.includes('mcp') || arms.some(usesPlugin) ? await startSnapshotServer(SIM_KEY) : null;
  if (snapshot) console.log(`snapshot server on ${snapshot.url}`);
  if (arms.includes('mcp') && !existsSync(join(MCP_REPO, 'dist', 'index.js'))) throw new Error(`The MCP arm needs a built gs-mcp at ${MCP_REPO} (set EVAL_MCP_DIR, run yarn build there)`);

  const workers = Array.from({ length: Number(values.concurrency) }, async () => {
    for (let next = queue.shift(); next && !outOfQuota; next = queue.shift()) await runOne(next, snapshot?.url ?? null);
  });
  await Promise.all(workers);
  await snapshot?.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
