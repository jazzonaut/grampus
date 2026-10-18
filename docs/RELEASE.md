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
- Regular-file repositories with bounded selected text context and unchanged binary
  assets. Context omissions must be explicit; changed files and instructions cannot
  be silently excluded. See [repository context and scale](REPOSITORY-CONTEXT.md).
- One task executing at a time through the first guided workflow. Existing low-level
  commands remain available; they do not yet enforce a global worker limit.
- Local checked commits and a journal-derived report. The user handles pushing.

macOS/Linux releases, published installers, Linear, automatic PR delivery, multi-task
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
At the previous dashboard checkpoint, the complete offline suite passed all 226
tests on Node 24 and 25, including
guided recovery, dashboard ownership/decision binding and native process settlement.

The local dashboard now provides plain-language kickoff against a pinned small
repository, consequential questions, reviewable generated plans and shared
task approval/execution controls. It displays instructions, file contents, changes,
check output, findings, a timeline and downloadable reports. `Grampus-Dev.cmd` opens
the developer distribution without remembering CLI commands. See
[DASHBOARD.md](DASHBOARD.md).

A live standalone browser trial reached verified local delivery with Codex
implementation and independent Claude review. An earlier generated-check failure
stopped without delivery and remains recorded; generated inline JavaScript is now
syntax checked before plan approval. This is fixture evidence, not an ordinary
project trial. The former full-repository context limit excluded the ordinary repositories
inspected locally. Selected context now removes that blocker; this change has
synthetic scale evidence and still needs ordinary-project trials.
Both provider pairings/workspace modes still need ordinary-project evidence.
Independent release review and clean distribution validation remain release work.

See [NEXT-SESSION.md](NEXT-SESSION.md) for the latest implementation checkpoint and
[INTEGRATION-EVIDENCE.md](INTEGRATION-EVIDENCE.md) for measured validation.

## Selected-context checkpoint

The dashboard now previews and searches a pinned repository inventory, supplies
bounded selected text and exposes omissions before approval. Planning context can
be expanded explicitly; old proposals are invalidated. Review requires every
changed file and repository instruction alongside the approved supporting files.
Artifact verification still covers the complete nonignored repository inventory.
The 100k-file scale probe and guided-workspace trial used no live providers and do
not replace gate 4. Ordinary-project trials, release review and distribution checks
remain outstanding. See [REPOSITORY-CONTEXT.md](REPOSITORY-CONTEXT.md).

Offline full suites passed all 235 tests on Node 24 and Node 25. Final focused
context/dashboard checks also passed all 15 tests on both runtimes after the last
state-race fixes. See [integration evidence](INTEGRATION-EVIDENCE.md) for the exact
scope, browser checks, scale timings and remaining release gates.

## Local installation checkpoint

A Windows per-user CLI installer now builds independent versioned snapshots from
the checkout, checks dependencies before installation and adds `grampus` to user
PATH. Installed and development copies use separate default data directories and
ports. `grampus update` explicitly rebuilds from the recorded checkout and activates
a checked replacement while retaining older version directories and task data.
CLI and dashboard identify version, mode and installed build. See
[INSTALLATION.md](INSTALLATION.md). This enables local trials; ordinary-project
evidence and release-wide review/distribution validation remain required.
