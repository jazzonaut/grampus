# Automatic local work and conversation efficiency

New plans default to automatic execution within their exact approved file scope:

1. Prepare the worktree and prerequisites.
2. Implement the current slice, then apply the selected edit quality passes.
3. Run validation. Return ordinary failures to the implementer with their evidence.
4. Independently review correctness and maintainability, assessing each selected quality
   lens. Repair concrete blocking findings and failed lenses within the allowance and obtain
   a new verdict. Validation, review and acceptance draw from one shared repair allowance.
5. Verify acceptance. Repairs invalidate earlier validation, review and acceptance.
6. Deliver the verified local commit and continue to the next slice.

The dashboard keeps current decisions and activity above separate results, plan, usage and evidence
views. Before approval, the plan view exposes the exact file permissions, command arguments, expected
output and complete plan JSON. **Request changes** opens the existing full-plan revision form; any
revision still needs approval of its new version and digest. During planning, **Create task for review**
creates an unapproved task. It does not start implementation. Planning token usage is visible before
conversion, with live, partial and unknown measurements labelled explicitly.

Questions, scope changes, uncertain process exits, check timeouts and other infrastructure
failures, mutating checks, prerequisite failures, exhausted allowances and repairs that leave
the failing artifact unchanged stop for attention. Each stop records a typed reason code beside its note, for example
`CHECK_REPAIR_EXHAUSTED` or `CHECK_NO_PROGRESS`
([guided state machine](ARCHITECTURE.md#guided-state-machine)).
An ordinary failed test does not require a manual retry or another approval
of the same file list. Valid tests and acceptance criteria must not be weakened to pass.
The agent may repair a defective test when it can establish the defect with evidence.

If the review turn fails, `REVIEW_TURN_FAILED` includes the recorded provider error in its stop
note when available. A failed connection supplies no verdict and does not trigger an automatic replay.

Up to `maxConcurrentTasks` guided tasks (2 by default) run this flow at once, each in its own
worktree, and they may share a source repository. Starting another task while every slot is
taken is refused rather than queued, and approving an automatic plan then approves it without
starting it; continue it once a slot is free
([parallel tasks](ARCHITECTURE.md#parallel-tasks-and-concurrency)).

Staging or unstaging files during an implementation stops that attempt because its
Git checkpoint changed. Finish staging, then choose **Retry repair**. Explicit retry
preserves those staged files and authorized edits, checks that HEAD, instructions
and file scope still match, and takes a new checkpoint. Automatic repair never
silently adopts an externally changed checkpoint.

The independent reviewer supplies an explicit assessment of each selected quality lens on
the current artifact. Grampus verifies each assessment's reviewer, attempt, version and
artifact before recording it as **agent evidence**, rather than inferring it from a passing
check. Runtime validation and acceptance remain controller evidence.

## Quality passes

Quality passes are declarative definitions, not code: an `id` (kebab-case), a `title`, a
`kind` and the `instructions` sent to the agent. There are two kinds:

- A **lens** is assessed by the independent reviewer inside its review turn. The verdict
  carries one `{ lens, verdict: "pass" | "fail", summary, findings }` entry per selected lens.
  A failed lens counts as a blocking finding and uses the shared repair allowance. A passing
  review that leaves a selected lens unassessed stops with `REVIEW_MISSING_LENS`. Each lens
  verdict is recorded as quality evidence for that lens, bound to the reviewer, attempt,
  version and artifact, and delivery requires a passing assessment of every selected lens.
- An **edit** pass is a scoped turn by the implementer, resuming the implementation
  conversation, after the slice's first successful implementation turn and before
  validation. It uses the slice's authorized paths rebuilt on what the implementation left,
  and its result is recorded as a `quality_pass.completed` execution event and in the task's
  `qualityEdits`. Edit passes run in the listed order and **once per slice**: repair attempts
  and explicit retries skip a pass that already completed, so repairs stay focused on the
  failure. A failed pass turn stops with `QUALITY_PASS_FAILED`; a retry starts a new attempt
  that runs the failed pass again after implementing. Validation always runs after the
  passes, so no evidence is taken before them.

| Built-in | Kind | Purpose |
| --- | --- | --- |
| `simplification` | lens | Simplification, naming, duplication and test quality (the default) |
| `naming` | lens | Misleading or lazy names and consistency with the codebase's vocabulary |
| `refactor` | edit | Improve the structure of the changed code without changing behaviour |
| `documentation` | edit | Add or repair TSDoc and comments for the changed code; why, not what |

A plan selects passes in `quality.passes`, as ids or full definitions:

```json
"quality": { "passes": ["simplification", "naming", "refactor"] }
```

Normalisation resolves ids to full definitions, so the approval digest covers the exact
instructions and a later settings change never alters an approved plan. A plan without
`quality` gets `defaultQualityPasses` (`["simplification"]` unless configured). An empty list
selects no passes: the reviewer is asked for no lens and no quality assessment is required.
At most six passes, unique ids, and instructions up to 4 KiB each. The planner never chooses
passes; change them at approval with **Revise this task's plan**. Custom definitions are
added in `config.json` ([configuration](CONFIGURATION.md)).

In supervised mode the person's assessment is the quality evidence: the task stops at
`awaiting_assessment` after submission and one outcome and summary cover every selected lens,
recorded as evidence for each. With no lenses selected it does not stop there. The reviewer
still returns lens verdicts in supervised mode, shown beside its findings, but they do not
replace the person's assessment.

## Rerun checks

A validation or acceptance check that stops for an infrastructure reason on an unchanged
artifact can be rerun without a new implementation attempt: **Rerun checks** on the
dashboard, or `task-rerun-checks <id> <decision-key>` with the key shown in `task-show`'s
next action. It runs the same approved check spec again on the same execution and attempt,
with a new check record and the usual evidence binding. No agent turn is sent.

It is offered after `CHECK_TIMEOUT`, `CHECK_INTERRUPTED`, `CHECK_EXIT_UNCONFIRMED`,
`CHECK_OUTPUT_UNAVAILABLE` and `CHECK_ERROR`, and only when the retained check proves its
process tree settled (never dispatched, or a confirmed exit). The controller then snapshots
the workspace and refuses the rerun if the artifact or repository instructions changed.
`CHECK_OUTPUT_LIMIT` and `CHECK_OUTPUT_TRUNCATED` are not offered, because the same command
on the same bytes produces the same output again: revise the check. A check whose
settlement is uncertain needs recovery, not a rerun.

A check's stdout and stderr go to its durable logs while it runs, so a timed-out check
keeps everything it printed before it was stopped. The stop note starts with the check,
its limit, the run time the supervisor measured and the retained output, for example
`Validation 'Tests' exceeded its 300 s limit after 300.4 s; partial output retained (5120
bytes).` Output a command holds back itself is lost when it is stopped: an inline script
that captures its children's output to print at the end leaves an empty log. The planner
is therefore asked to keep each slice's single validation command focused on one tool and,
when it must chain several, to stream their output and print a line before each step.

Automatic mode never reruns a check on its own: a timeout is always surfaced for you to
decide. Automatic repair treats only a genuine, confirmed, fully observed failure on the
unchanged artifact as an implementation problem; infrastructure stops never spend the
repair allowance. **Retry repair** remains available and starts a fresh attempt.

## Configuration

The policy is part of the approved plan, visible at approval and editable in
**Revise this task's plan**:

```json
"workflowPolicy": {
  "mode": "automatic",
  "repairRounds": 6,
  "maxSessionTurns": 6,
  "maxContextTokens": 120000
}
```

These are the defaults for a new plan that omits the policy or some of its fields;
`defaultWorkflowPolicy` in `config.json` changes them for new plans only
([configuration](CONFIGURATION.md)).

`mode` defaults to `automatic`. `mode: "supervised"` adds file-authorization and
manual quality assessment checkpoints and leaves failed checks for a manual retry (see
[the guided CLI](GUIDED-WORKFLOW.md#supervised-mode)).
Repair rounds accept 0–10, defaulting to six. Validation, independent review and acceptance
spend the same allowance for the current slice. It survives manual retry and restarts;
a new slice or revised plan gets a new allowance. An explicit retry authorises one further
attempt without replenishing automatic repairs. Infrastructure failures never spend it.

A new related review finding can be repaired automatically after earlier blockers are resolved.
The controller assigns stable identities to the preceding verdict's blockers, including failed
selected lenses. The reviewer returns `priorFindings`, one `{ id, status, evidence }` per identity,
with `status` either `resolved` or `unresolved`. Further automatic repair requires a changed
artifact and complete, evidenced resolution of every earlier blocker. The same artifact or
an unresolved blocker stops with `REVIEW_NO_PROGRESS`; missing, duplicate or foreign identities
stop with `REVIEW_PROGRESS_UNCONFIRMED`. These claims are agent evidence, not controller proof
of semantic correctness. Passing reviews must also account for prior blockers. All earlier
verdicts remain available to the reviewer.

`reviewPolicy` selects optional fresh arbitration only. A stalled review, missing progress
evidence or exhausted shared allowance can go to that approved arbitrator once. Arbitration
receives the artifact and full review history; an unresolved verdict stops.

Changing the mode, scope, commands or policy values uses a plan revision and fresh
approval; the approval digest always covers the complete current plan.

Each failed check or blocking review records `guided.repair_decided` in the same transaction
as its state transition. It names the source, triggering result, execution, artifact, progress,
action and shared budget before the decision. Review dispositions remain in the linked session's
structured reply. This makes the choice to repair, arbitrate or stop inspectable alongside the
existing request/result, check and usage journals.

This policy uses journal schema 2. Schema 1 journals are refused without modification; there is
no migration. Keep the previous installed build with its journal to finish an existing task.

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
totals counted once and each turn attributed to its stage (planning, implementation,
quality pass, repair, review or arbitration;
[usage accounting](ARCHITECTURE.md#usage-accounting)). No claim of a particular percentage saving is made.

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
explicit retry over staged files. Boundary tests exercise context thresholds, tool access,
large Unicode logs beyond the journal preview, compact polling and paginated UI output.
Provider process and recovery tests retain the existing no-replay contracts.
