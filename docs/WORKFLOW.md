# Automatic local work and conversation efficiency

New plans default to automatic execution within their exact approved file scope:

1. Prepare the worktree and prerequisites.
2. Implement and simplify the current slice.
3. Run validation. Return ordinary failures to the implementer with their evidence.
4. Independently review correctness, maintainability and simplification. Repair concrete
   blocking findings within the allowance and obtain a new verdict.
5. Verify acceptance. Repairs invalidate earlier validation, review and acceptance.
6. Deliver the verified local commit and continue to the next slice.

Questions, scope changes, uncertain process exits, mutating checks, prerequisite failures,
exhausted allowances and repairs that leave the failing artifact unchanged stop for
attention. An ordinary failed test does not require a manual retry or another approval
of the same file list. Valid tests and acceptance criteria must not be weakened to pass.
The agent may repair a defective test when it can establish the defect with evidence.

Staging or unstaging files during an implementation stops that attempt because its
Git checkpoint changed. Finish staging, then choose **Retry repair**. Explicit retry
preserves those staged files and authorized edits, checks that HEAD, instructions
and file scope still match, and takes a new checkpoint. Automatic repair never
silently adopts an externally changed checkpoint.

The independent reviewer supplies an explicit simplification assessment of the current
artifact. Grampus verifies that assessment's reviewer, attempt, version and artifact
before recording it as **agent evidence**, rather than inferring it from a passing check.
Runtime validation and acceptance remain controller evidence.

## Configuration and existing tasks

The policy is visible in plan approval and editable in **Revise this task's plan**:

```json
"workflowPolicy": {
  "mode": "automatic",
  "repairRounds": 2,
  "maxSessionTurns": 6,
  "maxContextTokens": 120000
}
```

`mode: "supervised"` adds file-authorization and manual-simplification checkpoints
(see [the guided CLI](GUIDED-WORKFLOW.md#supervised-mode)).
Check repair rounds accept 0–5; the limit is shared by validation and acceptance for
the current slice and survives manual retry/restarts. A new slice or revised plan
gets a new allowance. Repeated failed content stops early.

`reviewPolicy` controls review repairs (0–2) and optional fresh arbitration.
Without that override, automatic review repairs use the workflow allowance, up to two. Review
repair counts are separate from check repair counts. Unresolved arbitration stops.

Previously saved plans keep their original digests and supervised semantics. At an
idle checkpoint, **Continue automatically within this plan** (CLI: `task-automate <id>`)
explicitly authorizes automatic work within that plan's existing scope and commands.
This records an event without rewriting the approved brief, resetting files or
reapproving the outcome. Operational failures still need inspection. Changing scope,
commands or policy values uses a plan revision and fresh approval.

## Reuse context at settled boundaries

An execution attempt is an evidence boundary; it need not be a new model conversation.
Retries create fresh attempt/evidence records but resume the same implementation
conversation within the slice. Rechecks resume the independent review conversation.
Implementation and review never share a conversation, and arbitration always starts
fresh. Each delivered slice starts with fresh conversations and authoritative task,
slice and delivery context.

Grampus exits each provider process after its turn. That preserves the existing
supervisor receipts, exclusive workspace ownership and restart recovery. Restarting
a process with its saved provider conversation ID restores history. Keeping an idle
process alive is primarily a latency optimization; it does not itself reduce the
model's input history.

Before resuming, Grampus checks the conversation's controller-turn count and latest
observed input context. Crossing either configured threshold starts a fresh provider
conversation. Unknown context size uses the turn limit; cumulative lifetime token
spend is never mistaken for the active context size. Provider compaction within a
turn remains provider-managed. Reset decisions happen between settled operations,
never halfway through tools or uncertain recovery. Changed Codex dynamic toolsets
also require a fresh conversation so evidence tools are actually available.

Resumed prompts avoid repeating the complete brief and inline repository contents.
They contain the current slice, criteria, artifact, exact file policy and compact
failure/review feedback. Agents can read current source, changes, installed dependency
source and full check evidence on demand. Fresh contexts receive a bounded deterministic
handoff from recorded state; Grampus does not spend another model call generating a
summary. Every new verdict still applies to the current artifact.

The defaults are configurable heuristics, not a measured universal optimum. Resetting
too early causes repeated investigation; waiting too long grows input context and
can retain obsolete assumptions. Usage stays visible, with resumed cumulative provider
totals counted once. No claim of a particular percentage saving is made.

On the retained PDF-export task, the repeated task-context JSON measured 25,125 bytes;
the resumed form measured 6,509 bytes. Another 146,660 bytes of automatically repeated
inline repository context is omitted on resume, with current files still available
through read tools. These are payload measurements, not model-token benchmarks.
Dependency reads support literal search with bounded snippets so inspecting a library
option does not require feeding the model an entire bundled JavaScript file.

Provider references checked for this implementation:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): persistent threads,
  thread resume, token-usage notifications and native compaction.
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions):
  full-context resume after process restart.
- [Claude Agent SDK usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking):
  cumulative usage across resumed sessions and per-step input/cache measurements.

## Failure details without a wall of output

The task card shows the failure name, assertion or compiler diagnostics. Check details
start collapsed. **Read stdout** and **Read stderr** fetch 16,000-character pages into
a bounded scroll area. Polling never sends raw logs or check snapshots. History keeps
checks from earlier attempts in the current slice.

Agents use `grampus_read_check` for task/version-bound settled check evidence, complete
approved expectations (`stream: "spec"`) and paginated output. Full durable log files
remain readable beyond the SQLite record's 64 KiB preview. Feedback preserves useful
diagnostics and log tails; serialized JSON is never cut in the middle.

Terminal colour/control sequences such as `ESC[31m` are formatting for a terminal,
not printable dashboard text. Grampus removes them from display and agent excerpts,
preserving UTF-8 and the original raw evidence. A failed assertion against an entire
binary PDF can also cause the test runner to dump decoded binary content. That is
test output, not a Unicode conversion failure; it stays out of the compact issue view.

## Verification

Offline integration tests exercise failed-check repair through verified local delivery,
no-progress stopping, acceptance repair with renewed evidence, reviewer resumption and
explicit legacy-task adoption. Boundary tests exercise context thresholds, tool access,
large Unicode logs beyond the journal preview, compact polling and paginated UI output.
Provider process and recovery tests retain the existing no-replay contracts.
