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
6. **Guided controller structure.** Prompts in their own module, one handler per stage,
   structural comparison instead of `JSON.stringify` equality.
7. **Use it for real.** Run three to five real tasks and keep a short log of clicks,
   stops, review catches and cost. That log sets the next priorities.

## Deferred until real use asks for them

Risk classes, defect benchmark and direct-agent baselines, CI and upgrade canaries,
capability fingerprints, support bundle, retention policies, causation IDs on every
event, cross-platform validation.
