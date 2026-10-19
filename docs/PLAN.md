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
  `no-non-null-assertion` are errors. Task and guided state records and journal event payloads are
  still read unvalidated by domain and orchestration.
- **Central configuration.** Done 19 October 2026. Fixed limits are in `src/config/limits.ts` and
  operational settings in `src/config/settings.ts`; an optional validated `config.json` in the data
  directory overrides ports, usage polling, the default check timeout and the default workflow
  policy ([CONFIGURATION.md](CONFIGURATION.md)). Concurrency and stall threshold keys are accepted
  but **Planned**. The stricter compiler flags from the structure step landed at the same time.
- **Configurable quality passes.** Done 19 October 2026. Declarative pass definitions (no code
  plugins) of two kinds: review lenses assessed in the independent review turn, and edit passes
  that run as scoped implementer turns after the first successful implementation and before
  validation, once per slice. Built-ins: simplification (lens, default), naming (lens), refactor
  (edit) and documentation (edit); custom definitions and the default selection are in
  `config.json`. The selected passes are resolved to full definitions in the approved plan digest.
  Implementation, validation, independent review, acceptance and delivery stay mandatory and
  ordered ([WORKFLOW.md](WORKFLOW.md#quality-passes)).
- **No backwards compatibility.** Done 18 October 2026. Legacy plan formats, digests, fields,
  migrations and `task-automate` are removed from code and docs. The schema restarts at version 1; an older
  journal is refused with a clear message and never modified. The new version uses a fresh
  journal file, so older installed snapshots can still finish their own tasks.

1. **Hygiene baseline.** Fix nested-repository reference bug, Prettier, typescript-eslint
   with a shrink-only baseline, `npm run check`, fast and full test scripts, `AGENTS.md`,
   current-state docs with history archived under `docs/history/`.
2. **Measurement and journal fixes.** Per-stage usage and counters, no separate naming
   call, Claude cache-write tokens, batched streamed output, snapshots out of task
   state, journaled dashboard errors, typed stop reason codes.
3. **Health and stalls.** Doctor checks the executables actually used, results are
   stored and shown, provider versions recorded per session with a change warning,
   stall detection that surfaces silence without killing anything, a recorded protocol
   replay test.
4. **Parallel tasks.** A small configurable limit (default 2) of guided tasks running
   at once, each in its own worktree.
5. **Dashboard.** Server-side view model (status, next action, attention items with
   reasons, workflow strip, usage), then a Vue 3 + Vite + Nuxt UI client that keeps the
   per-launch token, loopback binding, CSP and decision-key checks unchanged.
6. **Guided controller structure.** Done 19 October 2026. Prompts in their own modules
   (`orchestration/guided/prompts.ts`, `orchestration/prompts/planner.ts`), one handler per stage
   with a typed outcome, structural comparison instead of `JSON.stringify` equality, and typed stop
   reason codes on the guided state and its journal events (the stop reason part of step 2).
7. **Use it for real.** Run three to five real tasks and keep a short log of clicks,
   stops, review catches and cost. That log sets the next priorities.

## Known issues from real use

- **Check timeout loses output.** A combined validation command exceeded its 120 s limit and
  left an empty log; the same checks run separately passed in about 55 s. Stream check output
  to the durable log as it arrives, record `CHECK_TIMEOUT` with elapsed time and limit, and
  have the planner prefer separate named checks. The default for new plans is now configurable
  (`defaultCheckTimeoutMs` in `config.json`). Investigate the
  slowdown (concurrent load, cold caches in a fresh worktree) with per-check timings.
- **Retrying validation starts a new implementation attempt.** Fixed 19 October 2026.
  Timeouts and other settled infrastructure failures on an unchanged artifact offer **Rerun
  checks** (`task-rerun-checks`): the same check, same artifact and attempt, no agent turn.
  Automatic repair only treats genuine check failures as implementation problems and never
  reruns on its own ([WORKFLOW.md](WORKFLOW.md#rerun-checks)).

## Deferred until real use asks for them

Risk classes, defect benchmark and direct-agent baselines, CI and upgrade canaries,
capability fingerprints, support bundle, retention policies, causation IDs on every
event, cross-platform validation.
