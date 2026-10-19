# Grampus

Grampus is a local controller for coding agents. You describe a change in plain
language; Grampus works with an agent to turn it into a concrete plan with acceptance
criteria, exact file scope and check commands. Once you approve that plan, it runs
the rest automatically: Codex or Claude implementation, validation, independent review
by the other provider, bounded repair of ordinary failures, acceptance checks and a
verified local Git commit for each slice.

The controller and its SQLite journal own the truth. Agents propose; the controller
decides. Every piece of evidence is bound to the exact repository content it describes,
an unknown outcome is never treated as success, and uncertain provider or Git
operations are never replayed. Grampus stops and asks for attention on questions,
scope changes, exhausted repair allowances and anything it cannot prove.

- [How the automatic workflow behaves](docs/WORKFLOW.md)
- [How the system is built](docs/ARCHITECTURE.md)
- [Product intent and design decisions](DESIGN.md)

## Requirements

- Windows 10 or later. Windows is the only supported and tested platform; macOS and
  Linux are **Planned**.
- Node.js 24 or later (Grampus uses the built-in `node:sqlite`), npm and Git.
- Windows PowerShell 5.1 or later. The check and delivery supervisor is compiled at
  runtime with `Add-Type`.
- Codex CLI, logged in with a ChatGPT subscription.
- Claude Code, logged in with a Claude subscription (Pro, Max, Team or Enterprise).
- Optional: a running local Orca app, if you want task worktrees created and tracked by Orca.

Both providers are needed for guided tasks, because the reviewer must be the other
provider from the implementer. Grampus refuses API-key and third-party provider
authentication, so it never enables separately billed API usage.

## Install

Double-click **Install-Grampus.cmd**, or run `npm run install:local` from this checkout.
The installer checks dependencies, builds an independent snapshot under
`%LOCALAPPDATA%\Programs\Grampus` and adds `grampus` to your user PATH. Open a new
terminal and run `grampus` to open the dashboard. Updates are explicit
(`grampus update`). See [installation and updates](docs/INSTALLATION.md).

## Run from the checkout

```sh
npm ci
npm run ui
```

Or double-click **Grampus-Dev.cmd**. This builds, starts the controller and opens the
dashboard in your browser. Keep the terminal open while you use it. The development
copy uses port 4318 and its own data directory, so it can run alongside an installed
copy (port 4317).

Use `npm run ui -- --port <n>`, `--db <path>` or `--no-open` to change the port,
journal or browser behaviour. Persistent overrides such as the dashboard port and the
default check timeout go in an optional `config.json`; see [configuration](docs/CONFIGURATION.md).

## The dashboard

The dashboard is the main interface. Choose **New task**, enter an existing
repository and describe the change. The planner explores the repository itself
(read-only), asks about anything consequential and proposes a plan of one or more
ordered slices. **Review for approval** shows the complete plan: outcome, criteria,
file actions, commands, expected output, agents and delivery messages. Approve it and
Grampus runs to a verified local commit unless something needs your attention.

The dashboard also shows progress, findings, check output, retained changes, a task
timeline, measured usage and a downloadable report. It offers stop, retry, recovery,
plan revision, reset and delete controls. See [the dashboard guide](docs/DASHBOARD.md).

Grampus makes local commits only. It never pushes, opens pull requests or merges.

## CLI reference

`grampus <command>` for an installed copy, or `npm start -- <command>` from a built
checkout. Every task command accepts `--db <path>`. `grampus --help` prints the full list.

| Commands | Purpose |
| --- | --- |
| `grampus`, `ui` | Open the dashboard (`--port`, `--db`, `--no-open`) |
| `--version`, `version [--json]`, `update [--source <checkout>] [--yes]` | Identify the build; install a fresh snapshot |
| `doctor [--orca]` | Check the Codex and Claude executables Grampus actually runs (handshake, login, MCP), Git, Node, PowerShell and Orca, and store the result for the dashboard. No inference |
| `demo` | Run a synthetic task in a temporary journal. Starts no agents |
| `task-new <plan.json>`, `task-show <id> [--details\|--json]` | Store a guided plan as a draft; show progress and the next action |
| `task-approve <id> <version> <digest>`, `task-run <id>` | Approve the exact plan; advance until input is needed |
| `task-authorize <id>`, `task-assess <id> --outcome <o> --summary <s>` | Supervised mode only: authorize file scope; record a quality assessment of the selected lenses |
| `task-answer <id> <answers.json>` | Answer pending agent questions |
| `task-retry <id>` | Retry after a stop |
| `task-rerun-checks <id> <decision-key>` | Rerun a check stopped by a timeout or other infrastructure problem on the unchanged artifact, without a new attempt |
| `task-revise <id> <version> <plan.json>` | Revise a settled plan, keeping files and delivered slices |
| `task-stop <id>`, `task-recover <id>`, `task-release-workspace <id>` | Stop, reconcile after a crash, release an unused failed reservation |
| `create`, `approve`, `list`, `show`, `report` | Low-level task records and the Markdown report |
| `workspace-new`, `-list`, `-show`, `-inspect`, `-recover`, `-release` | Low-level worktree lifecycle (Git or `--orca`) |
| `execution-new`, `-list`, `-show`, `-close`, `-snapshot`, `-implement`, `-check`, `-finish`, `-assess`, `-review`, `-verify`, `-complete`, `-deliver`, `-recover` | Low-level execution gates, one call per step |
| `implementation-show`, `-recover`; `check-show`, `-recover`; `delivery-show`, `-recover` | Inspect or reconcile individual supervised operations |
| `session-new`, `-send`, `-answer`, `-show`, `-list`, `-recover` | Standalone live conversations with Codex or Claude |

The guided `task-*` commands are the supported CLI workflow; see
[the guided CLI](docs/GUIDED-WORKFLOW.md). The low-level commands drive single gates
directly and are mainly for diagnosis and tests. Optional overrides:
`GRAMPUS_CODEX_COMMAND`, `GRAMPUS_CLAUDE_COMMAND` and `ORCA_CLI_COMMAND`, each a single
executable path rather than a shell command. A Codex installed with npm needs no override: the native
binary its package vendors is used instead of the `codex.cmd` shim, and `grampus doctor` shows the path.

## Data and privacy

Task data lives outside the checkout. On Windows that is
`%LOCALAPPDATA%\Grampus\installed\` for an installed copy and
`%LOCALAPPDATA%\Grampus\development\<checkout-id>\` for a checkout, in the journal
`grampus.sqlite`. A journal from another Grampus version is refused, never migrated or
modified. Check output and
supervisor receipts sit beside the journal in `<journal>.checks/`. Set `GRAMPUS_HOME` or
pass `--db` to choose another location. Journals and reports contain task content,
local paths and process identities: keep them out of commits and inspect reports
before sharing them. There is no automatic retention cleanup yet.

## Development

| Command | Purpose |
| --- | --- |
| `npm ci` | Install exact dependencies |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint. Existing violations are baselined in `eslint-suppressions.json`, which may only shrink |
| `npm run lint:prune` | Remove suppressions for violations you have fixed |
| `npm run format`, `npm run format:check` | Apply or check Prettier formatting |
| `npm test` | Build, then run the fast test subset (skips files listed in `scripts/slow-tests.json`) |
| `npm run test:all` | Build, then run every test file |
| `npm run check` | Typecheck, lint, format check and fast tests. Run before finishing a change |
| `npm run check:full` | The same with every test (several minutes) |
| `node scripts/run-tests.mjs <name>...` | Run selected compiled test files after a build |

Tests are offline. They use temporary Git repositories, SQLite files and fake
providers, and never call a live model. Opt-in live probes use your subscriptions and
retain their fixtures under the ignored `.grampus/` directory: `npm run probe`,
`probe:task`, `probe:multifile`, `probe:exploration`, `probe:mcp` and `probe:references`.
`probe:context` is an offline scale probe.

Contributor rules and pitfalls are in [AGENTS.md](AGENTS.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Automatic mode, repair allowances, context reuse, failure display |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current components, state, invariants and module map |
| [docs/DASHBOARD.md](docs/DASHBOARD.md) | Using the dashboard |
| [docs/GUIDED-WORKFLOW.md](docs/GUIDED-WORKFLOW.md) | Authored JSON plans, the guided CLI and supervised mode |
| [docs/REPOSITORY-CONTEXT.md](docs/REPOSITORY-CONTEXT.md) | Repository exploration, reference folders, MCP connections, limits |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Installing, updating and running alongside a checkout |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Optional `config.json` settings and what stays fixed |
| [docs/RELEASE.md](docs/RELEASE.md) | Windows alpha scope and remaining release gates |
| [docs/PLAN.md](docs/PLAN.md) | Current improvement plan |
| [docs/ENGINEERING_DIRECTION.md](docs/ENGINEERING_DIRECTION.md) | Long-term engineering direction |
| [DESIGN.md](DESIGN.md) | Product intent and decision record |
| [docs/history/](docs/history/README.md) | Archived checkpoints and evidence; not current truth |
