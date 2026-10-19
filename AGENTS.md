# Working on Grampus

Grampus is a local controller that turns a plain-language request into an approved plan,
then runs Codex or Claude implementation, validation, independent review, bounded repair,
acceptance and verified local Git delivery. The controller and its SQLite journal own
the truth; agents, the dashboard and the CLI only propose or display. Current behaviour
is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/WORKFLOW.md](docs/WORKFLOW.md); [DESIGN.md](DESIGN.md) is product intent and
[docs/PLAN.md](docs/PLAN.md) is the current improvement plan.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install exact dependencies |
| `npm run check` | Typecheck, lint, format check and the fast test subset. Run before saying you are done |
| `npm run check:full` | The same with every test (several minutes) |
| `npm test` / `npm run test:all` | Build the server (`build:server`), then run fast or all tests |
| `node scripts/run-tests.mjs <name>...` | Run selected compiled test files after `npm run build:server`, e.g. `guided-tasks` |
| `npm --prefix web ci`, then `cd web && npm run typecheck && npm run lint && npm test` | The dashboard client (Vue, own `package.json`); `npm run build` builds it to `web/dist` |
| `npm run format` | Apply Prettier |
| `npm run lint:prune` | Shrink `eslint-suppressions.json` after fixing suppressed violations |
| `npm run ui` | Build server and client, then open the development dashboard |
| `npm run doctor` | Check local Codex, Claude and Orca integration readiness |

## Rules

- Keep the guardrails: controller owns truth, evidence is bound to the exact artifact and
  version, unknown is never success, never replay an uncertain provider dispatch or Git write.
- State changes and their journal events are written in the same transaction (`Store.transaction`).
- No backwards compatibility: one journal schema, one plan format, no migrations. Never add legacy
  fields or fallbacks for records written by older versions; the store refuses other schema versions.
- Bug fixes start with a failing test. Tests use real temporary Git repositories and SQLite
  files; fake providers live in the tests, not in `src/`.
- New lint violations are not allowed. `eslint-suppressions.json` only shrinks.
- No new magic numbers: add a fixed bound to `src/config/limits.ts` (anything bound into approval,
  evidence or recovery) or an operational value to `src/config/settings.ts` (overridable through
  `config.json`, documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). Library code reads
  `currentSettings()`; entry points install settings once.
- The compiler runs with `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`: use
  `import type` for type-only imports and bracket access (`value['key']`) only for genuinely dynamic
  records. New environment variables are declared in `src/config/environment.d.ts`.
- Document exported functions, classes and non-obvious invariants with TSDoc. Each module
  starts with a short comment saying what it owns. Explain why, not what.
- Docs move with code: update the current-state docs in the same commit. Mark unbuilt
  behaviour as **Planned**. Point-in-time records go in `docs/history/`.
- UK English. No em dashes in docs, UI text or commit messages.
- Commit messages: imperative summary line under 72 characters, then a short body.

## Pitfalls

- Tests run from `dist/`. Run `npm run build:server` (or `npm test`) after editing TypeScript.
- The dashboard client in `web/` draws server DTOs (`src/server/api-types.ts`) and sends `ActionView.request`
  unchanged; business rules belong in `src/server/view-model/`, never in a component. Its own lint limits
  are stricter (300 lines per file, complexity 15).
- Working copies use CRLF on Windows; Prettier keeps existing line endings (`endOfLine: auto`).
- `C:\Users\<you>` may itself be a Git repository. Tests must not assume a temp folder is
  outside every repository.
- Modules are grouped by responsibility in folders under `src/`; the module map in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#module-map) says where each one lives.
- The guided state machine is in `src/orchestration/guided/`: `controller.ts` (public `GuidedTasks`
  API, drive loop), one handler per stage in `stages/`, prompts in `prompts.ts` and stop reason codes
  in `stop-reasons.ts`. Import from the defining module (`guided/controller.js`, `guided/keys.js`,
  `guided/state.js`); there is no barrel. Prompt text is a provider contract: change it deliberately.
  Its scenario tests are `test/guided-tasks-*.test.ts` (run `node scripts/run-tests.mjs guided-tasks`
  while iterating); `test/guided-stop-reasons.test.ts` pins stop codes without Git or providers.
- A new stop (blocked, waiting or recovery) needs a `StopReasonCode` and a test asserting
  `state.stopReason.code`. Keep the existing `note` text; the dashboard and tests read it.
- Test files over about 10 s are listed in `scripts/slow-tests.json` and skipped by `npm test`.
  Keep each test file under about 45 s; tests within one file run sequentially.
- Both providers are pinned dependencies. Codex is driven through `codex app-server` JSON-RPC from the
  native binary of the pinned `@openai/codex` package; Claude runs through the pinned
  `@anthropic-ai/claude-agent-sdk` and its bundled executable. `GRAMPUS_CODEX_COMMAND` and
  `GRAMPUS_CLAUDE_COMMAND` override them. Upgrading either is a deliberate change: re-record the
  protocol fixtures (`test/fixtures/protocol/`) and run the live probes.
- The installed application (`%LOCALAPPDATA%\Programs\Grampus`) and its journal are separate
  from a development checkout. Never modify them from development work.
