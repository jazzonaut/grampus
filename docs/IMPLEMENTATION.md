# Implementation sequence

The user authorized starting the initial technical validation and implementation on
17 October 2026. DESIGN.md remains the product specification. This sequence makes
the first milestone concrete; it does not describe the whole product as delivered.

## First slice: durable controller and integration evidence

Use TypeScript on Node.js 24 or newer, with Node's SQLite binding and test runner.
This keeps the initial controller free of runtime npm dependencies and native addon
builds. SQLite's Node binding is still experimental on Node 24; isolate it in the
store module. Developer packaging is npm plus compiled JavaScript. A bundled
installer remains a later decision, after validation on all supported platforms.

The first slice includes:

- A single-slice workflow with a versioned brief, criteria and plan, explicit
  approval, attempts, check/review/verification evidence, decisions, and completion.
- Atomic updates to task state and its append-only journal in a local SQLite file
  outside the checkout. No credentials in the journal.
- Attempt identities and requirement versions to reject late or duplicate results.
- Stop requested distinct from stopped. Recovery marks an interrupted controller's
  active work as needing reconciliation; it never assumes a child process stopped.
- A terminal demonstration and a deterministic Markdown report from stored events.
- Repeatable local capability checks and narrowly bounded live protocol probes.

Acceptance examples:

1. Create a task, approve version 1, implement, validate, independently review and
   verify it; completion requires simplification, validation, independent review
   and acceptance verification evidence for the current attempt.
2. Revise the brief to version 2 after version 1 ran; version 1 approval and evidence
   cannot authorize or complete version 2. A late version 1 response is journaled.
3. Request a stop while running; task remains stop-requested until an explicit
   confirmation. Reopening the database does not convert uncertain work to success.
4. A failed/skipped check or unresolved decision prevents completion. A report
   preserves failures even after a successful retry.
5. Reopening the journal after a controller interruption preserves criteria,
   attempts and evidence. Recovery requires reconciliation before another attempt.

Validation: behavioral tests against real temporary SQLite databases, child-process
restart tests, CLI smoke runs, local capability probes. Synthetic demonstration
evidence is labelled and is not evidence of a real coding task or independent code
review. Live agent probes, if run, only establish the specific capabilities observed.

## Next slices toward the first milestone

1. **Agent lifecycle — initial slice implemented:** Codex app-server and Claude
   Agent SDK adapters, persisted structured question/answer routing, review
   findings, usage snapshots, interrupt, process exit confirmation, and reconnect.
   Existing subscription authentication is required; API billing remains disabled.
   Retries are bounded at zero automatic inference retries until task-level budgets
   and replay rules are implemented. Native tool approval routing is deferred to
   workspace execution; questions currently use structured final replies.
2. **Workspaces and execution — Git and Orca creation implemented:** durable task/path
   reservations, pinned base commits, standalone locks or Orca instance identities,
   inspection and conservative creation recovery. Task/attempt/session bindings and
   exclusive per-workspace turn ownership are also implemented. Explicit Windows
   checks now supervise tool descendants and bind validation to repository snapshots.
   Provider-driven edits, shared concurrency, recovery and sequential commits remain.
3. **One real task:** run a tiny coding task through both agents, independently
   inspect output, interrupt/recover, and repeat with and without Orca. Complete
   this milestone only when those real cases pass.
4. **Dashboard and distribution:** kickoff, versioned approval, timeline, decision
   review and report views; installation and platform CI. Preserve standalone use.

The first slice does not enable arbitrary agent edits, automatically schedule
workers, create real review approvals, push branches, or publish anything. Agent
and model effort mappings remain unselected until measured pilot tasks exist.

## Live-session slice

Authorized by the user's request for the next step. The initial implementation is
a conversation transport and journal, not an unattended coding scheduler.

- Use the official Claude Agent SDK for lifecycle controls rather than copying its
  internal control protocol. This adds a pinned runtime dependency and bundled
  native executable. Codex uses the installed app-server directly.
- One controller claims each Grampus session in a SQLite transaction. Persist its
  run id, controller/agent PIDs and execution host. Ignore events from older runs.
- Every CLI turn closes its provider process. Reconnect using the exact persisted
  provider session id, retaining the observed model and working directory.
- Replies are validated as messages, questions or review findings. Question ids
  survive application restarts. Answers are recorded before the next turn.
- Store streamed output and provider usage snapshots. Cumulative usage must not be
  summed across snapshots; estimated USD is not actual billed cost. Unknown remains
  null, including Codex cost and both providers' billed cost.
- A timeout or Ctrl+C records stop-requested before requesting interruption. A
  terminal provider event and confirmed owned process exit are distinct evidence.
  Failed shutdown blocks reuse. Recovery never automatically replays a prompt.

Acceptance checks: live question/answer across separate controllers, context and
review findings after reconnection, a cancelled turn followed by successful resume;
offline tests for schema migration, concurrent ownership, crash reconciliation,
late events, malformed output, provider failure, deadlines and unconfirmed exits.

## Standalone workspace slice

Authorized by the user's request to continue implementation in the same session.
Schema 3 adds workspace state and events, retaining task and conversation history.
The CLI creates an isolated worktree only for an exact approved real task version.
It journals intent before launching Git, pins the base commit, preserves the source
checkout and records a unique branch/lock. Recovery inspects an existing result
without repeating a possibly completed operation. Failed operations retain their
reservations; automatic cleanup and rebinding are deliberately not provided yet.

Acceptance checks use actual temporary Git repositories and separate CLI/controller
processes: dirty source preservation, competing reservations, incorrect approval,
existing/nested destinations, pinned bases, Git failure, lost responses, real process
exit before the ready transaction commits, uncertain liveness, dirty recovery,
changed lock identity, stale task versions and schema 2 migration.

The subsequent slices add task/session bindings and execution leases, then narrowly
scoped repository commands and evidence tied to inspected artifacts.

## Orca workspace slice

The local Orca adapter uses the installed CLI, validated against its bundled guide
and help. It creates a task worktree through Orca with an explicit pinned base, skips
Orca setup hooks and requests no agent. Orca controls path and branch selection.
Schema 4 permits an unbound Orca reservation, then captures the returned full id and
stable instance identity before checking the actual Git worktree.

Recovery does not equate CLI exit with server completion. A lost reply is reconciled
through exact request-marker discovery followed by identity and Git verification;
there is no creation replay. Missing, ambiguous, incomplete, remote or mismatched
results stay blocked. The adapter does not change Orca metadata through raw Git.

Validation includes protocol fixtures backed by real Git repositories and a live
local Orca probe with a deliberately discarded response and a fresh recovery process.
Execution leases and task/attempt/session links follow below. Workspace readiness
alone is not authorization to run an agent.

## Linked-session ownership slice

Schema 5 adds execution bindings, execution events and one durable lease per workspace.
Preparation atomically links an approved task version, attempt, fresh session and
workspace using nested SQLite savepoints. Both implementation and independent-review
roles are represented; same-provider review records its fallback reason. No inference
starts during preparation, and no conversation result creates acceptance evidence.

Each linked turn claims the workspace before checking its current identity and
connecting the provider. Successful replies keep implementation open; failed/stopped
attempts require a fresh binding. Confirmed settlement releases session and workspace
ownership together. Uncertain startup/shutdown retains ownership without expiry or
replay. Recovery checks process absence; late runs cannot release newer ownership.
Unlinked sessions and legacy active sessions cannot bypass managed workspace ownership.

Validation uses real Git repositories, separate controller processes and protocol
fixtures: nested rollback, version/role validation, competing review sessions, parallel
independent workspaces, question continuation, interruption, malformed replies, failed
inspection, uncertain startup/shutdown, process-crash recovery, Orca identity replacement,
CLI persistence and schema 4 migration. Current adapters remain conversation-restricted.

## Repository check slice

Schema 6 adds retained check specifications, snapshots, process identities and results.
`execution-snapshot`, `execution-check`, `check-show` and `execution-finish` provide
an explicit command path without enabling provider repository tools. The caller reads
the repository instructions and selects a concrete command tied to the current content
and instruction digests. Snapshot collection preserves raw file changes and avoids
Git clean filters, external diff drivers and fsmonitor hooks on this path.

The Windows helper uses atomic Job Object assignment and kill-on-close ownership.
Normal exit, failure, timeout, interruption, remaining descendants and missing
supervisor confirmation have distinct outcomes. Only confirmed tree exit releases
ownership. Unknown shutdown and controller crashes cannot replay work or use
conversation recovery to free the lease.

Submission requires the latest passing check and a matching fresh content snapshot.
It atomically marks implementation successful and records validation. It does not
satisfy simplification, independent review or acceptance verification. Fixture tests
implement a greeting change and verify its actual output, then exercise stale inputs,
changed instructions, command mutations, failures, rollback, controller/supervisor
crashes, detached descendants, Unicode arguments, output limits, CLI restarts and
schema migration. Platform support for this helper is currently Windows only.

Next: check/snapshot ownership recovery, artifact-aware independent review and explicit
acceptance checks, then provider tool policies and one real task through all gates.
Workspace release/rebinding, bounded scheduling and other-platform supervisors remain.
