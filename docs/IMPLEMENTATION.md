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
2. **Workspaces and execution:** standalone Git worktrees and Orca-owned worktrees,
   exactly one execution owner, shared concurrency, real checks and sequential
   commits. Validate ownership and stopping on Windows before extending claims.
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
