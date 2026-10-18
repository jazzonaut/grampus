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
| `npm test` / `npm run test:all` | Build, then run fast or all tests |
| `node scripts/run-tests.mjs <name>...` | Run selected compiled test files after `npm run build`, e.g. `guided-tasks` |
| `npm run format` | Apply Prettier |
| `npm run lint:prune` | Shrink `eslint-suppressions.json` after fixing suppressed violations |
| `npm run ui` | Build and open the development dashboard |
| `npm run doctor` | Check local Codex, Claude and Orca integration readiness |

## Rules

- Keep the guardrails: controller owns truth, evidence is bound to the exact artifact and
  version, unknown is never success, never replay an uncertain provider dispatch or Git write.
- State changes and their journal events are written in the same transaction (`Store.transaction`).
- Bug fixes start with a failing test. Tests use real temporary Git repositories and SQLite
  files; fake providers live in the tests, not in `src/`.
- New lint violations are not allowed. `eslint-suppressions.json` only shrinks.
- Document exported functions, classes and non-obvious invariants with TSDoc. Each module
  starts with a short comment saying what it owns. Explain why, not what.
- Docs move with code: update the current-state docs in the same commit. Mark unbuilt
  behaviour as **Planned**. Point-in-time records go in `docs/history/`.
- UK English. No em dashes in docs, UI text or commit messages.
- Commit messages: imperative summary line under 72 characters, then a short body.

## Pitfalls

- Tests run from `dist/`. Run `npm run build` (or `npm test`) after editing TypeScript.
- Working copies use CRLF on Windows; Prettier keeps existing line endings (`endOfLine: auto`).
- `C:\Users\<you>` may itself be a Git repository. Tests must not assume a temp folder is
  outside every repository.
- The guided state machine is in `src/guided-tasks.ts`; its tests are
  `test/guided-tasks-*.test.ts`. Run `node scripts/run-tests.mjs guided-tasks` while iterating.
- Test files over about 10 s are listed in `scripts/slow-tests.json` and skipped by `npm test`.
  Keep each test file under about 45 s; tests within one file run sequentially.
- Codex is driven through `codex app-server` JSON-RPC and is not version-pinned. Claude runs
  through the pinned `@anthropic-ai/claude-agent-sdk`, which bundles its own executable unless
  `GRAMPUS_CLAUDE_COMMAND` is set.
- The installed application (`%LOCALAPPDATA%\Programs\Grampus`) and its journal are separate
  from a development checkout. Never modify them from development work.
