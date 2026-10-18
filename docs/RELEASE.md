# Windows alpha release

On 18 October 2026 the user agreed to target a small Windows alpha before the
broader three-platform release described in [DESIGN.md](../DESIGN.md).
This is the release target, not a claim that an alpha is ready.

The first release should let its user finish a small real coding task without
manually coordinating every provider call, check and delivery command.

## Supported scope

- Windows 10 or later, local execution, Node.js 24 or later and Git.
- Existing Codex and Claude subscription logins, with independent other-provider
  review and no separately billed API access enabled automatically.
- Standalone Git worktrees and optional local Orca workspaces.
- Small text repositories within the implemented context and file-operation limits.
  Larger repositories must be refused with an actionable explanation until review
  context can be selected without hiding relevant code.
- One task executing at a time through the first guided workflow. Existing low-level
  commands remain available; they do not yet enforce a global worker limit.
- Local checked commits and a journal-derived report. The user handles pushing.

macOS/Linux releases, installers, Linear, automatic PR delivery, multi-task
scheduling and full unattended operation follow this alpha. The broader design
remains the product direction. A basic interface and clear recovery are part of
usability, rather than optional polish.

## Release gates, in order

1. **Dependable recovery.** Reproduce and resolve intermittent process-liveness
   failures without dropping ownership safeguards. A stopped implementation must
   resume through a fresh attempt and reach verified delivery, preserving partial
   edits and the original approval. Missing settlement proof remains blocked.
2. **One guided task workflow.** Connect brief clarification, versioned approval,
   workspace setup, implementation, validation, explicit simplification, independent
   review, acceptance, local delivery and report. Keep the selected files, checks
   and acceptance examples reviewable before execution. Stop with a clear next
   action on questions, findings, failed checks or uncertain shutdown. Do not infer
   a simplification pass or replay a provider turn after a restart.
3. **Basic interface.** Provide task kickoff/approval, progress, pending questions,
   findings and decisions, stop/recovery controls and final evidence. Use the same
   controller state for CLI and UI so the interface cannot bypass a gate.
4. **Real-project trials.** Finish small changes in existing repositories, including
   a review finding that requires repair and an interrupted implementation completed
   through a fresh attempt. Exercise both provider pairings and both workspace modes.
   Fixture pilots remain useful evidence but do not replace ordinary-project trials.
5. **Review and distribution.** Independently review Grampus itself. Verify a clean
   installation using the documented developer distribution, subscription discovery,
   persisted state after restart and readable reports. Run the complete offline
   suite on supported Node 24 and the development version, including default
   parallel execution. Record limitations and failed/skipped validation explicitly.

## Current position

The durable controller and individual gates work, including live sequential
fixture delivery. The PID-reuse recovery fix and recovery through fresh-attempt
completion pass offline verification on Node 24 and 25. A foreground guided CLI
now connects the execution gates, including explicit scope/assessment checkpoints,
questions, stop/retry and restart reconciliation. See
[GUIDED-WORKFLOW.md](GUIDED-WORKFLOW.md).
The complete offline suite now passes all 226 tests on Node 24 and 25, including
guided recovery, dashboard ownership/decision binding and native process settlement.

The local dashboard now provides plain-language kickoff against a pinned small
repository, consequential questions, reviewable generated plans and shared
task approval/execution controls. It displays instructions, file contents, changes,
check output, findings, a timeline and downloadable reports. `Grampus.cmd` opens
the developer distribution without remembering CLI commands. See
[DASHBOARD.md](DASHBOARD.md).

A live standalone browser trial reached verified local delivery with Codex
implementation and independent Claude review. An earlier generated-check failure
stopped without delivery and remains recorded; generated inline JavaScript is now
syntax checked before plan approval. This is fixture evidence, not an ordinary
project trial. The current review context limit excludes the ordinary repositories
inspected locally, so broader context selection is needed before those trials.
Both provider pairings/workspace modes still need ordinary-project evidence.
Independent release review and clean distribution validation remain release work.

See [NEXT-SESSION.md](NEXT-SESSION.md) for the latest implementation checkpoint and
[INTEGRATION-EVIDENCE.md](INTEGRATION-EVIDENCE.md) for measured validation.
