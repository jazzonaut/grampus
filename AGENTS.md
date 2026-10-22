# Working on Grampus

Grampus turns a plain-language request into a verified result by running a fixed, measurable pipeline
of Orca workers: spec, approval, optional tests first, build, deterministic checks, cross-family review
and bounded repair. Orca owns lifecycle (runs, tasks, dispatches, workers); Grampus owns the pipeline,
verification and an append-only evidence log per task. Current behaviour is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); [DESIGN.md](DESIGN.md) is intent and decisions.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install exact dependencies |
| `npm run check` | Typecheck, lint, format check and the fast tests. Run before saying you are done |
| `npm run check:full` | The same with every test |
| `npm test` / `npm run test:all` | Build (`npm run build`), then run fast or all tests |
| `node scripts/run-tests.mjs <name>...` | Run selected compiled test files after `npm run build`, e.g. `pipeline-repair` |
| `npm run format` | Apply Prettier |
| `npm run dev:web` | Serve the dashboard with hot reload; it forwards `/api` to a running `grampus dashboard` |
| `node dist/src/cli.js <command>` | Run the CLI (`status`, `new`, `skill install`, ...) |

## Rules

- Guardrails: unknown is never success; never replay an uncertain mutation except by its recorded
  request id; evidence is bound to a commit SHA and a spec version; unknown measurements stay unknown.
- Every Orca mutation goes through `DriverCore.mutate` with a request id from `DriverCore.requestId`,
  recorded before the call. Orca replays a repeated id instead of acting twice.
- The driver is the only writer to its task's Orca Run and event log (apart from `grampus new`, and
  `grampus merge`, which appends `task.merged` after the task finished).
  Clients queue commands in `commands.jsonl`; they never call Orca orchestration for a task.
- Pipeline steps are idempotent: each checks the folded state before acting, so a restarted driver
  resumes at the first missing step. Decision points use stable keys with `DriverCore.decide`.
- No backwards compatibility: one event schema (`eventSchemaVersion`), no migrations. The store refuses
  logs written with another schema.
- Bug fixes start with a failing test. Tests use real temporary Git repositories; the fake Orca and fake
  workers live in `test/helpers/`, never in `src/`.
- New lint violations are not allowed. `eslint-suppressions.json` only shrinks.
- No new magic numbers: a bound that changes what a recorded spec, check or review means goes in
  `src/config/limits.ts`; an operational value goes in `src/config/settings.ts` (overridable through
  `config.json`, documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). Library code reads
  `currentSettings()`; entry points install settings once.
- The compiler runs with `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`: use
  `import type` for type-only imports. New environment variables are declared in
  `src/config/environment.d.ts`.
- Document exported functions and non-obvious invariants with TSDoc. Each module starts with a short
  comment saying what it owns. Explain why, not what.
- Docs move with code: update the current-state docs in the same commit. Mark unbuilt behaviour as
  **Planned**.
- UK English. No em dashes in docs, UI text or commit messages.
- Commit messages: imperative summary line under 72 characters, then a short body.

## Pitfalls

- Tests run from `dist/`. Run `npm run build` (or `npm test`) after editing TypeScript.
- The dashboard (`web/`) imports its JSON types from `src/dashboard/types.ts` as types only. Name icons
  as `i-lucide-*` literals so the build bundles them; a test checks every name exists.
- Worker prompts in `src/pipeline/prompts.ts` are a contract with the agents and change measured
  results. Change them deliberately and say so in the commit.
- Orca's CLI contract moves quickly. Its JSON is parsed in `src/orca/protocol.ts`; unknown fields are
  ignored and optional ones may be absent. Re-check the spike findings in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#orca-contract) after an Orca upgrade.
- An Orca terminal can coordinate one Run. A second `run-create` from the same terminal fences the first.
- Working copies use CRLF on Windows; Prettier keeps existing line endings (`endOfLine: auto`).
- `C:\Users\<you>` may itself be a Git repository. Tests must not assume a temp folder is outside every
  repository.
- The earlier standalone Grampus is installed separately (`%LOCALAPPDATA%\Programs\Grampus`, data in
  `%LOCALAPPDATA%\Grampus\installed`). This version uses `%LOCALAPPDATA%\Grampus\orca` and never reads
  the old data.
