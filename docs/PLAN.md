# Grampus revamp plan

Prepared 18 October 2026 from an audit of the source code against
[ENGINEERING_DIRECTION.md](ENGINEERING_DIRECTION.md). The direction document stays
as the long-term intent; this plan is the short, executable subset.

## Assessment

The direction document predates the automatic workflow ([WORKFLOW.md](WORKFLOW.md)).
New plans already run from approval to verified local commit without further clicks
when nothing goes wrong, so most of its section 2 is done. Context reuse and "unknown
cost is never zero" from section 4 are done too.

The real gap is evidence on real projects: every recorded validation so far uses
offline fixtures or isolated live probes. The plan therefore fixes the cheap,
high-value problems, adds measurement, and then lets real use decide what follows.

| Direction section | State in code | Decision |
| --- | --- | --- |
| 2 Bounded autonomy | Mostly implemented; no risk classes | Keep. Defer risk classes and Quick/Standard/Thorough until real use shows a need |
| 3 Seeded-defect benchmark, direct-agent baselines | Missing | Defer. Keep a real-task log first; add a few seeded fixtures only if reviews look weak |
| 4 Efficiency | Totals per provider only | Do: per-stage usage, turns, retries, wall time, interventions; drop the naming call; fix cache-write tokens |
| 5 Integration health | `doctor` only, can check a different Claude binary than the SDK uses | Do a light version: correct doctor, persisted results, version-change warning, health card, one recorded protocol fixture. Defer canaries and CI matrices |
| 6 UI | One 62 KB string-template file, rules duplicated in the client, no attention queue or health view | Do: server-side view model, then Vue 3 + Vite + Nuxt UI dashboard |
| 7 Maintainability | No formatter, lint, AGENTS.md; 250-line state switch; 7 minute tests | Do the cheap parts. Skip package splits and dependency injection |
| 8 Diagnostics | Plain journal; every streamed chunk is its own transaction | Do: batch streamed output, slim task state, journal worker errors, reason codes for stops. Defer diagnostic depths, support bundle, retention |

## Steps

- **Task observability.** Initial implementation, 20 October 2026: provider item and tool lifecycle
  metadata, a bounded read projection over the existing journals, a compact task network and a
  dedicated observability page with filters, inspection and event replay. Completed participants
  remain visible in grey. Capture coverage and limitations are explicit
  ([OBSERVABILITY.md](OBSERVABILITY.md)). Deeper inference tracing and comparison of attempts are
  **Planned**.

Order changed on 18 October 2026: structure and typing come before feature work, so new
work lands in the new structure. Order: 1, split tests, structure and strictness, then 2-6.

- **Structure and strictness.** Modules grouped by responsibility, stricter compiler flags,
  typescript-eslint `strictTypeChecked`, zod validation at every external boundary
  (provider events, journal payloads, API bodies, plan files), discriminated unions instead
  of `any` and casts, TSDoc on exported surfaces. Recovery, artifact binding and no-replay
  semantics stay unchanged; the existing tests are the safety net. Boundary validation is done for
  provider protocols, agent replies, supervisor output and receipts, worker files, execution-layer
  journal records, Orca and Git output, dashboard bodies and CLI input
  ([ARCHITECTURE.md](ARCHITECTURE.md#external-boundaries)); `no-explicit-any` and
  `no-non-null-assertion` are errors. Task and guided state records and kickoff events are
  validated on read; other journal event payloads are still read field by field by their consumers.
- **Central configuration.** Done 19 October 2026. Fixed limits are in `src/config/limits.ts` and
  operational settings in `src/config/settings.ts`; an optional validated `config.json` in the data
  directory overrides ports, usage polling, the default check timeout and the default workflow
  policy ([CONFIGURATION.md](CONFIGURATION.md)). The concurrency key is used since step 4
  and the stall threshold since step 3. The stricter compiler flags from the structure step landed at the same time.
- **Configurable quality passes.** Done 19 October 2026. Declarative pass definitions (no code
  plugins) of two kinds: review lenses assessed in the independent review turn, and edit passes
  that run as scoped implementer turns after the first successful implementation and before
  validation, once per slice. Built-ins: simplification (lens, default), naming (lens), refactor
  (edit) and documentation (edit); custom definitions and the default selection are in
  `config.json`. The selected passes are resolved to full definitions in the approved plan digest.
  Implementation, validation, independent review, acceptance and delivery stay mandatory and
  ordered ([WORKFLOW.md](WORKFLOW.md#quality-passes)).
- **Progress-aware shared repairs.** Done 19 October 2026. Validation, review and acceptance
  share one approved slice allowance (three by default, up to ten). Continued blocking reviews
  must resolve preceding blockers with explicit identities and evidence; stalled or unknown
  progress stops or uses approved arbitration. Decisions are journaled with their reasons and
  budget. The journal schema refuses other versions without migration ([WORKFLOW.md](WORKFLOW.md)).
- **No backwards compatibility.** Done 18 October 2026. Legacy plan formats, digests, fields,
  migrations and `task-automate` are removed from code and docs. The current schema is version 5; an older
  journal is refused with a clear message and never modified. The new version uses a fresh
  journal file, so older installed snapshots can still finish their own tasks.

1. **Hygiene baseline.** Fix nested-repository reference bug, Prettier, typescript-eslint
   with a shrink-only baseline, `npm run check`, fast and full test scripts, `AGENTS.md`,
   current-state docs.
2. **Measurement and journal fixes.** Done 19 October 2026. Usage, turns, failed and
   interrupted turns, wall time per stage (planning, implementation, quality passes, repair,
   review, arbitration, tagged on executions and turn requests), repair attempts and human
   interventions after approval, in the report, `task-show`, the task poll and the dashboard.
   Claude cache-write tokens and Codex cache writes are counted. Resumed sessions were checked
   live: both providers continue their counters across resume, and aggregation also handles a
   counter that restarts ([usage accounting](ARCHITECTURE.md#usage-accounting)). The naming call
   is gone (a title from the request until the plan names the task). Streamed output is
   coalesced per run (`outputFlushIntervalMs`, `outputFlushBytes`), guided state keeps snapshot
   references with the snapshots in a content-addressed table, the runner check reads an
   indexed column, and failed dashboard actions are journaled as `dashboard.action_failed`.
   Typed stop reason codes landed with step 6.
3. **Health and stalls.** Done 19 October 2026. `doctor` resolves the Codex and Claude
   executables with the adapters' own functions (`providers/executables.ts`) and runs their
   real handshakes without inference; the typed result is stored in the journal (`health`
   table), refreshed when stale at dashboard start and before a dashboard run, and shown in a
   header card and `/api/health`. Sessions record the provider executable, version and SDK
   version; a version that differs from the last successful delivery is a warning, never a
   block. Silent running turns and checks are surfaced after `stallWarningMs` with one
   `guided.stall_detected` event per silence and nothing stopped. Recorded Codex and Claude
   protocol fixtures are replayed through the adapters as a drift canary
   ([ARCHITECTURE.md](ARCHITECTURE.md#health-and-stalls)).
4. **Parallel tasks.** Done 19 October 2026. A bounded runner pool replaces the single
   global runner: up to `maxConcurrentTasks` (default 2, 1 to 4) guided tasks own a runner at
   once, each in its own worktree, and they may share a source repository. A full pool refuses
   the claim with a typed error (409 in the dashboard, a message naming the running tasks in
   the CLI) instead of queueing, because there is no background scheduler; recovery is never
   blocked by a full pool. The pool also bounds simultaneous guided agent turns. Process
   identity queries moved out of hot-path journal transactions and the busy timeout rose to
   15 s, so writers from parallel tasks wait rather than fail
   ([ARCHITECTURE.md](ARCHITECTURE.md#parallel-tasks-and-concurrency)).
5. **Dashboard.** Server-side view model (status, next action, attention items with
   reasons, workflow strip, usage), then a Vue 3 + Vite + Nuxt UI client that keeps the
   per-launch token, loopback binding, CSP and decision-key checks unchanged.
   - **5a. View model and API v1.** Done 19 October 2026. `server/view-model/` makes every
     presentation decision the legacy client duplicated (status vocabulary, stop descriptions,
     note language, action availability, labels and disabled reasons, repair allowance and
     automatic-mode wording, rerun eligibility, workflow strip with evidence sources, usage
     completeness) and `server/api-types.ts` types the read routes `/api/v1/overview`,
     `/api/v1/tasks/:id` (with `timeline` and `changes`) and `/api/v1/kickoffs/:id`. Actions
     reuse the existing POST routes through `ActionView.request`
     ([ARCHITECTURE.md](ARCHITECTURE.md#dashboard-view-model-and-api-v1)). `web/` is typed against the DTOs.
   - **5b. Vue client.** Done 19 October 2026. `web/` (Vue 3, Vite, Nuxt UI) draws the overview with the
     attention queue first, new task, planning conversation, task detail and health screens on API v1,
     with forms generated from `ActionView` and no optimistic state; it is served from `web/dist` under
     the unchanged token, origin, loopback and CSP rules and built into each installed snapshot. The
     legacy `src/ui` client, its routes (`/api/state`, the task poll and events) and its tests are gone;
     every route now answers errors with the typed envelope ([DASHBOARD.md](DASHBOARD.md)). The
     runner pool is in the overview; actions that need a slot are disabled with the reason while it is
     full, and a refused one (409 `pool_full`) or an approval left unstarted is a calm wait notice.
6. **Guided controller structure.** Done 19 October 2026. Prompts in their own modules
   (`orchestration/guided/prompts.ts`, `orchestration/prompts/planner.ts`), one handler per stage
   with a typed outcome, structural comparison instead of `JSON.stringify` equality, and typed stop
   reason codes on the guided state and its journal events (the stop reason part of step 2).
7. **Use it for real.** Run three to five real tasks and keep a short log of clicks,
   stops, review catches and cost. That log sets the next priorities.

## Run visibility and control

Implemented 19 October 2026. The task screen keeps live changed files and a selected unified diff
visible outside the evidence tabs, refreshed every `liveChangesIntervalMs` (five seconds by default).
These are bounded observations against the task's pinned base, including delivered slices and current
staged, unstaged and untracked changes, never verification evidence. Binary files use Git's binary
notice; truncated or unavailable previews are explicit. Diff drivers, clean/process filters and text conversion are disabled.

The screen shows the current slice's shared repair allowance and recent controller decisions, with
the trigger, progress assessment, remaining budget and result/artifact identities. Full history stays
in the timeline. New plans default to three automatic repairs; explicit approved allowances remain
bound to their plan. **Pause after this step** lets the current operation settle before stopping;
**Continue task** resumes the same attempt. Failures and uncertain operations retain their failure or
recovery reason. Persisted pause, guidance and task spending policy are part of the journal schema (now 6); other versions are refused without migration.
The installed application and its journal are separate from this checkout.

Queued human guidance is implemented. Messages are bound to the approved version and slice,
assigned atomically to the next matching agent step, and visible with cancellation and assignment
history. They survive pauses and restart without changing approval or starting extra turns.
Unassigned guidance stops delivery for an explicit decision. Recovery never replays uncertain input.

Task-wide spending allowances are implemented. New plans default to 20 requested provider turns,
with an optional token threshold. The ledger spans linked planning, retries, all slices and revisions.
The controller stops before another agent turn when allowance is exhausted or token headroom is
unknown. Active turns settle normally and can exceed the token threshold. The task screen, CLI and
report expose the totals; raising them requires a revised plan and fresh approval.

Orca desktop visibility is implemented: `ui --orca`, journal-derived worktree cards and
attention markers while the dashboard is open, and verified navigation to the task in
its Orca workspace. Provider processes remain Grampus-owned ([DASHBOARD.md](DASHBOARD.md)).

The native Orca command plugin and background start-or-reconnect launcher are implemented.
Install and update generate the production package at `<installation directory>\orca-plugin`;
one-time Orca enablement adds Open and Stop Dashboard commands, with assignable shortcuts.
The installed entry follows atomic snapshot selection, including when Orca copies its package;
application/journal-bound discovery and process receipts prevent duplicate live controllers
([ORCA.md](ORCA.md)). A native task-summary panel remains **Planned**.

**Planned:** a finding disposition ledger and native Orca conversation/control integration.

## Known issues from real use

- **Check timeout loses output.** Fixed 19 October 2026. A combined validation command exceeded
  its 120 s limit and left an empty log; the same checks run separately passed in about 55 s. The
  supervisor already gives the tool file handles on the durable logs, so output reaches them as it
  is written and a timed-out check keeps it (now covered by a test); an empty log means the command
  held its own output back, typically an inline script capturing child output to print at the end.
  The supervisor now reports the elapsed time, and `CHECK_TIMEOUT` notes name the check, limit,
  measured time and retained bytes. The plan format allows one validation command per slice, so
  the planner is asked to keep it focused on one tool and, when chaining is unavoidable, to stream
  child output and size the timeout for every step. Several named validation checks per slice
  would need a plan format change and is not done. The slowdown itself (concurrent load, cold
  caches in a fresh worktree) can now be read from per-check elapsed times.
- **Retrying validation starts a new implementation attempt.** Fixed 19 October 2026.
  Timeouts and other settled infrastructure failures on an unchanged artifact offer **Rerun
  checks** (`task-rerun-checks`): the same check, same artifact and attempt, no agent turn.
  Automatic repair only treats genuine check failures as implementation problems and never
  reruns on its own ([WORKFLOW.md](WORKFLOW.md#rerun-checks)).
- **One acceptance command ran out of time.** Fixed 20 October 2026. A slice's single acceptance
  command chained unit tests and three browser suites. Its first run failed four end-to-end tests
  after 8.6 minutes; after a repair the same command reached the 600 s cap with three tests already
  failed, so the stop (`CHECK_TIMEOUT`) could not spend a repair and the failure summary was never
  printed. A slice now approves an ordered list of up to `planLimits.acceptanceChecks` named
  acceptance commands, each with its own timeout. They run in order on one artifact, the first
  failure stops the rest and names its position, a rerun resumes at the stopped check, a repair
  runs them all again, and delivery needs the latest result of every one to pass. The planner is
  asked to split slow suites into their own checks. Journal schema 6.

## Deferred until real use asks for them

Risk classes, defect benchmark and direct-agent baselines, CI and upgrade canaries,
capability fingerprints, support bundle, retention policies, causation IDs on every
event, cross-platform validation.
