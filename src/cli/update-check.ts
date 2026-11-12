// Tells the agent when a newer plugin is out. Claude Code leaves auto-update off for marketplaces outside
// Anthropic's, and Codex and copied skills update only when asked, so without this a merchant keeps building on
// old rules and old reference code. One GET per run, made while the check runs; any failure (offline, slow, GitHub
// down) adds nothing to the output.

export interface Release {
  /** This plugin's version, from plugin/.claude-plugin/plugin.json at build time. */
  version: string;
  /** The GitHub repository the plugin installs from, as owner/name (package.json config.repository). */
  repository: string;
  /** The released plugin.json on that repository's main branch (package.json config.latest). */
  latest: string;
}

export interface PluginUpdate {
  installed: string;
  latest: string;
  tell_the_developer: string;
  how_to_update: string;
  after_updating: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function isNewer(latest: string, installed: string): boolean {
  const a = VERSION.exec(latest)?.slice(1).map(Number);
  const b = VERSION.exec(installed)?.slice(1).map(Number);
  if (!a || !b) return false;
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i]! > b[i]!;
}

/** The update command for the way this copy was installed, read from where the script sits. */
function howToUpdate(scriptPath: string, repository: string): string {
  const path = scriptPath.replaceAll('\\', '/');
  if (path.includes('/.claude/plugins/cache/')) {
    return 'In a terminal, run `claude plugin marketplace update globalstack`, then `claude plugin update globalstack@globalstack`, and restart Claude Code.';
  }
  if (path.includes('/.codex/plugins/cache/')) return 'In a terminal, run `codex plugin marketplace upgrade globalstack` and restart Codex.';
  // Cursor pins a plugin added from GitHub to the commit it was added from; Update and Reinstall install that commit
  // again (Cursor staff, forum.cursor.com, July 2026). Only Cursor Marketplace plugins update, and this one is not listed.
  if (path.includes('/.cursor/plugins/cache/')) {
    return `Cursor does not update a plugin added from GitHub. Remove the globalstack plugin in Customize, run \`npx skills add ${repository} --skill '*' -a cursor --copy -y\` in the project folder and restart Cursor. Later updates are \`npx skills update -y\`.`;
  }
  // `npx skills add` copies the skill folder into an agent folder of the project, such as .agents/skills/.
  if (/\/\.[^/]+\/skills\/globalstack-integration\//.test(path)) return 'In the project folder, run `npx skills update -y` and restart the agent.';
  return `Install the latest version. In Claude Code: \`/plugin marketplace add ${repository}\`, then \`/plugin install globalstack@globalstack\`. In Codex: \`codex plugin marketplace add ${repository}\`. In other agents, in the project folder: \`npx skills add ${repository} --skill '*' -a cursor --copy -y\`.`;
}

export async function checkForUpdate(
  release: Release,
  scriptPath: string,
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<PluginUpdate | null> {
  const { fetch: get = fetch, env = process.env, timeoutMs = 1500 } = options;
  if (env.GLOBALSTACK_NO_UPDATE_CHECK) return null;
  // A plain timer, not AbortSignal.timeout(): that one does not keep the process alive while it waits.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await get(release.latest, { signal: abort.signal });
    if (!response.ok) return null;
    const latest = String(((await response.json()) as { version?: unknown }).version ?? '');
    if (!isNewer(latest, release.version)) return null;
    return {
      installed: release.version,
      latest,
      tell_the_developer: `A newer Global Stack plugin is out (${latest}; this one is ${release.version}). Tell the developer once, with how_to_update, and carry on with this version.`,
      how_to_update: howToUpdate(scriptPath, release.repository),
      after_updating: "Run build_check_acceptance: it lists the app's copies of code/ that changed, which are fixes to copy in.",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
