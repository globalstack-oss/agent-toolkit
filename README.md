# Global Stack plugin

Helps a coding agent build a correct Global Stack integration on the first try. It runs on the developer's
machine. It installs from this repository, `globalstack-oss/agent-toolkit`.

| Part | Where | What it does |
| - | - | - |
| Integration skill | `plugin/skills/globalstack-integration/` | `SKILL.md`: the build steps, the rules the API enforces and the traps merchants hit. `checklist.md`: the code checklist. `playbooks.md`: one playbook per flow. `reference.md`: formats, fields and tables, by topic. |
| Reference code | `plugin/skills/globalstack-integration/code/` | Tested TypeScript for retries, lost responses, crash recovery and webhooks. Copy it unchanged. |
| Account check | `plugin/skills/globalstack-integration/scripts/gs.mjs` | Read-only checks with your own key: route open or gated, access requests, webhooks, wallets, payout details, docs search. `GET` only. |
| Testing skill | `plugin/skills/globalstack-testing/` | A local copy of the API that fails on purpose (lost response, provider error, rate limit, missing or forged webhooks). Never calls the real API. |

## Install

Claude Code:

```
/plugin marketplace add globalstack-oss/agent-toolkit
/plugin install globalstack@globalstack
```

Codex:

```
codex plugin marketplace add globalstack-oss/agent-toolkit
```

Cursor and any agent that reads `.agents/skills/`, from the project folder:

```
npx skills add globalstack-oss/agent-toolkit --skill '*' -a cursor --copy -y
```

This copies both skill folders into the project's `.agents/skills/`. The plugin is these two skills and nothing else,
so the copy loses nothing. Cursor does not update a plugin added from GitHub, so use `npx skills` there.

## Quickstart, no key needed

You can build and test a whole integration before you have a Global Stack account. The failure sandbox is a local
copy of the API: it never calls the real API and needs no key.

1. Install the plugin (above) and start your agent in your app's folder.
2. Ask it: "Build a Global Stack payout to a Nigerian bank account, and test it in the failure sandbox." Name your
   own flow: pay out or collect, currency, country, bank or mobile money.
3. The agent reads the playbook for the flow and writes the code on the reference code. Without a key, the account
   checks answer `unknown` and the playbook still comes back.
4. The agent starts the sandbox (`sandbox.mjs start --app-port <your port> --fault <fault>`), points your app at
   it, and runs the flow through your app once per fault. Each run ends with a report; the goal is no warnings.

To see it on a finished app first, run `npm test` in this repository: it runs the two apps in `examples/` against
every fault. The example apps know who is calling from a login token (`Authorization: Bearer
<token>`), kept in a small `sessions` table that stands in for your app's own login: `npm run setup` in an example
prints a token per demo user. Your app takes the user from its real login, never from the request body.

## Optional: read-only account checks with a Viewer key

With a key, the agent can also check your live account: is the route open or gated, are access requests pending,
is a webhook registered, what is in your wallets. These checks only read (`GET` only), so the agent never needs a
key that can move money: in the Global Stack dashboard, create an API key with the Viewer role. The scripts read it
from `GLOBALSTACK_API_KEY`; never put a key in a project file or the chat. The account check warns when the agent's
key can move money.

```
export GLOBALSTACK_API_KEY=gsa_sk_...      # macOS, Linux (bash, zsh)
$env:GLOBALSTACK_API_KEY = "gsa_sk_..."    # Windows PowerShell
```

Run it in the terminal you start the agent from. An editor or desktop app (Cursor, the Codex app) does not see a
variable set in a terminal session: add the line to your shell profile (`~/.zshrc`, `~/.bashrc`; on Windows,
`setx GLOBALSTACK_API_KEY gsa_sk_...`), then restart the editor.

The scripts need Node 20 or later, whatever language your app is in.

## Going live: the developer's step, not the agent's

There is no Global Stack test mode: the first call with a key that can move money moves real money. The plugin has
no tool that writes, so the agent cannot make that call. You make it, once, after these are true:

1. Every sandbox fault that applies to the flow ends with no warnings, and you checked each `check_in_app` item in
   your app's database.
2. `gs.mjs build_check_acceptance '{"flow":"<flow>"}'` with your Viewer key shows every item passed: the route is
   open, access is approved, a webhook is active, the wallet has funds.
3. Someone other than the agent has read the code that moves money.

Then:

1. Put your app's own key, which can move money, in the app's deploy environment. Never give it to the agent: it
   stays in that environment, and the agent keeps the Viewer key.
2. Run the flow's smallest live test through your app, as a user would: the playbook names it, for example the
   minimum amount to a Nigerian bank account you own.
3. Check three things: the money arrived (your bank or phone shows it), your app shows the payment completed, and
   the final webhook reached your app once.
4. Only then open the flow to real users.

## Updates

Each run of `gs.mjs` reads the latest version number from `plugin/.claude-plugin/plugin.json` on this repository's
`main` branch (raw.githubusercontent.com): one `GET`, which sends no key. When your copy is older, the result starts with `plugin_update` and the agent tells you
once how to update. Set `GLOBALSTACK_NO_UPDATE_CHECK=1` to turn this off.

| Installed with | To update, in a terminal |
| - | - |
| Claude Code | `claude plugin marketplace update globalstack`, then `claude plugin update globalstack@globalstack`. Restart Claude Code. The second command alone does not see a new release. |
| `npx skills add` | `npx skills update -y` in the project folder. |
| Codex | `codex plugin marketplace upgrade globalstack`. Restart Codex. |

Claude Code does not update plugins from this marketplace on its own. To update at each start instead, open
`/plugin`, go to Marketplaces, select `globalstack` and enable auto-update.

After an update, run `build_check_acceptance`: it lists the app's copies of `code/` that changed, which are fixes to
copy in.

## For maintainers

The installed plugin is the `plugin/` folder only. For each release:

1. Run `npm run docs:refresh`. It rebuilds the docs copy that `search_docs` reads when the live docs cannot be
   reached, from github.com/Paystack-Passport/docs, the repo the site is built from, so it needs no access to the
   site. Read the new changelog entries against the skills.
2. Raise `version` in `plugin/.claude-plugin/plugin.json` and run `npm ci && npm run build`: it bundles the scripts
   from `src/` and writes the Cursor manifests from the Claude ones. The bundles have no dependencies and are
   committed, so users never run a build.
3. Merge to `main`. Users update through their marketplace, and `gs.mjs` tells every older copy to update.

Users get a release only when `version` changes.

`npm run typecheck` checks `src/`, the tests, and the reference code under the strictest settings apps use.
`npm test` runs the reference code's own tests and the example apps in `examples/` against every fault of the
failure sandbox. CI (`.github/workflows/ci.yml`) runs both, rebuilds and fails if the committed bundles differ,
validates the manifests with `claude plugin validate --strict`, fails on a high or critical `npm audit` advisory in
the shipped dependencies, and scans the full git history for secrets with gitleaks (settings in `.gitleaks.toml`).
Its actions are pinned to commit SHAs: when you update one, pin the new SHA and keep the version as a comment.

`benchmarks/` holds the integration jobs a coding agent is graded on, one folder per job, with results and how to
run them ([benchmarks/README.md](benchmarks/README.md)). The same folder holds the harness and starter apps
they run on. CI grades every job's reference app, with the plugin's current reference code, on every failure scenario.

## License

MIT, in `LICENSE`. `npm run build` copies it into the plugin and each skill folder, and each file in `code/` names it
in two lines under its banner, so the copies and ports merchants make keep it.
