# Automatic local work and conversation efficiency

New plans default to automatic execution within their exact approved file scope:

1. Prepare the worktree and prerequisites.
2. Implement the current slice, then apply the selected edit quality passes.
3. Run the approved mechanical readiness checks, then behavioural validation. Return ordinary failures to the implementer with their evidence, using the appropriate bounded allowance.
4. Independently review correctness and maintainability, assessing each selected quality
   lens. Repair concrete blocking findings and failed lenses within the allowance and obtain
   a new verdict. Behavioural validation, review and acceptance draw from one shared repair allowance. Declared formatting, lint and type checks have a separate readiness allowance.
   The reviewer is shown the slice's approved readiness, validation and acceptance commands and judges
   whether they will establish each criterion; acceptance has not run yet, so its absence is
   never a finding. A criterion that needs the results of a later check is raised as a
   question rather than a blocker, because no repair can resolve it.
5. Verify acceptance: run the slice's acceptance checks in their approved order on the same
   artifact. The first failure stops the rest and is handled like any failed check. Repairs
   invalidate earlier validation, review and acceptance, so every acceptance check runs again.
6. Deliver the verified local commit and continue to the next slice.

The dashboard keeps current decisions and activity above separate results, plan, usage and evidence
views. Before approval, the plan view exposes the exact file permissions, command arguments, expected
output and complete plan JSON. **Request changes** opens the existing full-plan revision form; any
revision still needs approval of its new version and digest. During planning, **Create task for review**
creates an unapproved task. It does not start implementation. Planning token usage is visible before
conversion, with live, partial and unknown measurements labelled explicitly. Planning and task
pages share the live communication graph and **Open full observability** for event inspection
and historical replay. Planning activity remains visible in the linked task without duplicate
sessions or events ([observability](OBSERVABILITY.md)).

For local Orca worktrees, the open dashboard also projects the task title, stage, slice
and attention onto the workspace card. Only verified final delivery is shown as completed.
**Open workspace in Orca** opens the task in that workspace without starting another agent.
These are display operations; they do not approve, pause, resume or complete work, and their
failure never changes the controller's outcome ([Orca desktop integration](DASHBOARD.md)).

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

## Implementation readiness

Each slice can declare an ordered `readiness` list, with at most one command of each kind:
`format`, `lint` and `types`. Each command includes `kind`, `name`, `file`, `args` and
`timeoutMs`. For example, a TypeScript project may approve:

```json
"readiness": [
  {
    "kind": "types",
    "name": "Typecheck",
    "file": "node",
    "args": ["node_modules/typescript/bin/tsc", "--noEmit"],
    "timeoutMs": 60000
  }
]
```

Readiness runs after the edit quality passes and prerequisite refresh, before behavioural
validation, on every attempt. Its commands must be read-only: use a formatting check, then let
the implementer fix files within its authorised scope. Tests, mixed check scripts, installation
and mutating formatters do not belong in readiness. The controller uses the declared category,
never an error-message heuristic. Omitted readiness normalises to an empty list for approval;
existing validation commands always use the behavioural allowance.

`workflowPolicy.readinessRounds` allows two automatic readiness repairs per slice by default,
separate from the three shared behavioural repairs. Both accept 0 to 10 and are visible and
editable before approval. Both survive restarts, explicit retries and every repair of the same
slice. A new slice or freshly approved plan revision starts fresh slice allowances; task-wide
turn and token totals still include earlier work. Repeated failure of the same readiness command
on unchanged content stops with `READINESS_NO_PROGRESS`; exhaustion uses
`READINESS_REPAIR_EXHAUSTED`. Infrastructure stops spend neither allowance and retain the same
explicit recovery or **Rerun checks** rules. Readiness passes never substitute for validation,
review or acceptance, and submission requires them on the exact current artifact.

Choose capacities for the task's scope and checks at approval. Running work never silently
increases an approved allowance. The task screen shows both budgets and each repair's subsequent
check results and review verdict, with artifact identities. Changed bytes and an implementer's
completion message never establish that a defect was fixed.

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

A readiness, validation or acceptance check that stops for an infrastructure reason on an unchanged
artifact can be rerun without a new implementation attempt: **Rerun checks** on the
dashboard, or `task-rerun-checks <id> <decision-key>` with the key shown in `task-show`'s
next action. It runs the same approved check spec again on the same execution and attempt,
with a new check record and the usual evidence binding. No agent turn is sent. In a slice
with several acceptance checks the rerun resumes at the check that stopped: checks that already
passed on the same artifact are not repeated, and the remaining ones follow in order.

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

## Model profiles and comparisons

The **Model profiles** screen saves fixed provider, model and reasoning effort choices for
planning, implementation, repair, independent review, arbitration and individual edit passes.
An omitted repair or edit assignment inherits implementation. An arbitration assignment enables
fresh arbitration. Assigning an edit pass a model does not select the pass: the approved plan must
also select that quality pass. Editing roles use the implementation provider, and independent
review uses the other provider. Unsupported provider effort values are refused. Grampus sends
model-specific choices directly to the provider and does not implement model fallback; requested
choices and any observed model are recorded separately.

Choose a profile on **New task** for ordinary planning and execution. The selected definition is
copied into the plan, so changing or removing the saved profile cannot change an approved task.
Within a run, each role's assignment stays fixed. Switching model or effort between roles starts
a fresh conversation with authoritative task context. Retries of an unchanged role can still
resume its settled conversation under the existing context policy.

To compare profiles, open a task and expand **Compare model profiles on this plan**. Select two to
eight profiles, prepare the comparison, inspect the shared plan and every effective assignment,
then choose **Approve all profiles** and **Run comparison**. The batch approval binds every member
task's exact version and configuration. Each variant starts from the same pinned base in its own
worktree and follows the ordinary evidence and local-delivery gates. Variants execute sequentially.
Planning is reused once; a profile's planning assignment does not start another planner during a
comparison. Plans revised against retained work cannot be used as fresh comparison templates.

Comparison members use **Approve all profiles** and **Run comparison** on the comparison screen;
their individual initial approval and continuation buttons are disabled with directions there.
If a member was already approved individually but has never started, batch approval accepts that
exact unchanged approval and approves the remaining profiles. It still checks every member's
version, plan and assignments together, and never adopts an approval with retained work.

Settled failures remain in the results and the next variant can run. Questions, supervised
checkpoints, user pauses and uncertain operations wait for a decision. Open the member task for its
normal answer or recovery actions, then return to **Run comparison** to continue the group.
**Pause comparison after this step** lets the active operation settle and prevents further group
dispatch until explicit continuation. A comparison driver left by a crashed process needs
**Recover comparison driver**; this releases only a provably dead owner and never replays a member
operation. Starting a future member directly through the task API or CLI is refused.

Creating a comparison leaves its source task unchanged. Its **Plan ready for approval** state does
not block the comparison; approving it would authorise a separate ordinary run. A member's
**Operation needs recovery** state concerns that member's unfinished operation. Recovery requires
its retained settlement evidence. A missing completion receipt cannot be replaced by approving the
source task or repeating recovery, and a fresh comparison does not fix an underlying supervisor
startup failure. The supervisor starts from its own helper directory, independently of where the
dashboard was launched.

If recovery cannot obtain a missing completion receipt and you want to abandon the run, choose
**Discard task** under task management. Every recorded task, workspace, session and comparison
controller must be provably absent on this host; live, foreign or unverifiable controllers block
discard. The task is hidden and cannot restart. Its dead guided runner stops occupying a task slot,
but uncertain outcomes, pending intent, workspace locks, files, commits and evidence are retained.
Discard neither stops a tool nor claims its process tree settled. A containing comparison loses
approval and cannot run again. The original source task is unchanged. Ordinary **Delete task** and
**Reset task** continue to require settled work.

The comparison being complete means all variants have settled, including any failures. Inspect
their individual delivery outcomes and changes before selecting a preferred verified run.
Selection records a preference without changing the source branch. **Inspect integration** shows
the source repository, branch, current HEAD and selected commit. Its separate confirmation offers
a fast-forward only when the source branch is still at the pinned base with clean raw files and
index. An advanced branch requires manual integration. Git intent is journalled before dispatch;
uncertain integration can only be reconciled from exact branch, commit and file evidence, never
automatically repeated. Reconciliation requires the original controller to be provably absent.

Every task has a run scorecard. Elapsed time covers first operation to verified completion; agent
time covers requested turns to settled results. Workflow execution and waiting time come from
recorded state intervals, through the displayed observation time. Waiting is not a measurement of
the user's attention. Token counters retain their provider meanings and coverage. Unknown values
stay unknown, including actual subscription charges and allowance consumed. Subscription rejection
counts use provider-reported observations only. Shared planning usage is displayed once, separately
from comparison member usage. Machine load, caches and subscription conditions can still differ
between sequential runs, so one result does not establish a universal model ranking.

**Export full JSON** includes complete retained journals, prompts, replies, tool activity,
configurations, model observations, evidence, snapshots and raw logs. Prepared prompts include
the final repository and review context when that preparation was reached. Preparation alone is
not proof of provider dispatch. Exports do not reuse truncated
dashboard previews. When retained Git objects are available it also includes a binary-capable
patch from the pinned base to the last verified delivery. **Export metrics CSV** provides one
scorecard row per run; **Export compressed JSON** contains the same full structure compressed with
gzip. Failed, interrupted and unfinished runs are exportable. Missing or oversized attachments are
explicit; each file is limited to 64 MiB. Journal snapshots are captured transactionally; raw logs
can continue growing during export. Provider-internal activity that was never observed remains
unavailable. Comparison JSON includes the shared planning session and its full journal once.

The CLI exposes the same operations. `comparison-show` prints the current `expected` decision key;
send that displayed key for each state-changing action, refreshing it after a change:

```text
model-profiles
metrics <task-id>
export <task-id>
comparison-new <task-id> <profiles.json>
comparison-show <comparison-id>
comparison-approve <comparison-id> <key>
comparison-run <comparison-id> <key>
comparison-pause <comparison-id> <key>
comparison-recover <comparison-id> <key>
comparison-select <comparison-id> <key> <task-id>
comparison-integration-preview <comparison-id>
comparison-integrate <comparison-id> <key> <target.json>
comparison-recover-integration <comparison-id> <key>
comparison-export <comparison-id> <output-file> [json|csv|gzip]
```

`profiles.json` is an ordered array of saved profile ids or full profile definitions.
For integration, save the displayed preview's `target` object as `target.json`. `export` prints
JSON to stdout, so ordinary shell redirection can save an individual run. All commands accept
the usual `--db` journal selection. Schema 8 requires a fresh journal; other versions are refused
without migration. Development work does not update the installed application or its journal.

## Configuration

The policy is part of the approved plan, visible at approval and editable in
**Revise this task's plan**:

```json
"workflowPolicy": {
  "mode": "automatic",
  "readinessRounds": 2,
  "repairRounds": 3,
  "maxSessionTurns": 6,
  "maxContextTokens": 120000,
  "maxTaskTurns": 20,
  "maxTaskTokens": 0
}
```

These are the defaults for a new plan that omits the policy or some of its fields;
`defaultWorkflowPolicy` in `config.json` changes them for new plans only
([configuration](CONFIGURATION.md)).

`mode` defaults to `automatic`. `mode: "supervised"` adds file-authorization and
manual quality assessment checkpoints and leaves failed checks for a manual retry (see
[the guided CLI](GUIDED-WORKFLOW.md#supervised-mode)).
Behavioural repair rounds accept 0–10, defaulting to three. Behavioural validation, independent review and acceptance
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
action and the relevant readiness or shared behavioural budget before the decision. Review dispositions remain in the linked session's
structured reply. This makes the choice to repair, arbitrate or stop inspectable alongside the
existing request/result, check and usage journals.

The current controller uses journal schema 8, including explicit readiness checks and their durable allowance alongside model assignments, comparisons, pause, guidance, task spending and ordered acceptance checks. Journals from
other schema versions are refused without modification; there is
no migration. Keep the previous installed build with its journal to finish an existing task.

## Task-wide spending allowances

New plans approve `workflowPolicy.maxTaskTurns: 20` and `maxTaskTokens: 0`. The turn allowance
accepts 1 to 1,000 requested provider turns. The token threshold accepts 0 to 1,000,000,000;
zero disables only the token gate. Set both in the plan or revision form, or change
`defaultWorkflowPolicy` in settings for future plans. Approval binds the effective values.

The controller checks before every implementation, edit pass, repair, independent review and
arbitration turn. It reads the durable task usage ledger, including linked planning and all
attempts, providers, slices and plan versions. Failed and interrupted requested turns count.
Restarting, pausing, retrying, rotating conversations or revising the plan never resets spend.
Planning before conversion is already spent and is included when the approved task starts;
these limits do not control the separate planning conversation before a plan exists.

A turn at the boundary finishes and settles normally. Before the next turn, exhausted turns
stop with `TASK_TURN_LIMIT`, observed tokens at or above the threshold stop with `TASK_TOKEN_LIMIT`,
and missing, partial or unsettled token measurements stop with `TASK_USAGE_UNKNOWN` when the token
gate is enabled. No dispatch intent is created and queued guidance stays queued. Files and exact
verification evidence remain available. Non-agent checks, recovery and verified local delivery
can finish when no further agent turn is needed.

The token total is Codex input plus output, and Claude input plus output plus its separate cache
reads and writes. Codex cache reads are already part of input and are not added again. Resumed
provider counters use the existing cumulative attribution; unknown values never establish headroom.
A known lower bound already at the threshold still proves exhaustion.

These are dispatch thresholds, not provider billing caps or predictions of the next turn's size.
An active turn can exceed the token threshold, and the limit does not interrupt it. The number of
provider-internal model/tool rounds within one requested Grampus turn is not a task turn count.
Estimated cost remains visible in Usage, but no dollar cap is enforced.

Budget stops offer **Revise this task's plan**. Approve a higher cumulative total (not an additional
allowance), or explicitly change the token policy; the revised plan needs fresh approval and all
its usual evidence gates. A manual retry cannot bypass a spending stop. The task screen, CLI,
report and `guided.spending_blocked` journal entry show the same calculation and measurement coverage.

## Pause without interrupting work

**Pause after this step** records a request while the controller is running. The active operation
finishes normally; after its result settles, Grampus stops before dispatching the next operation.
The stop reason is `USER_PAUSED`, and **Continue task** resumes the same attempt, keeping the files,
conversations and bound evidence. A pause does not consume a repair round. If the active operation
stops for a failure, asks a question or cannot prove settlement, that failure, question or recovery
requirement takes precedence. Nothing uncertain is marked paused or replayed. Completion needs no pause.

Live changes on the task screen are observations of the worktree against the pinned task base, not
evidence that passes any gate. The repair panel explains recent controller decisions and remaining
shared allowance; progress attributed to a reviewer remains an agent assessment.

A review or check can schedule a repair during settlement, before the pause takes effect.
The panel labels these rounds as allocated, even if their next agent turn has not started.
Continuing does not allocate that same round again; actual turns and usage are reported separately.

## Guide a future agent turn

Queue guidance from the task screen or CLI without interrupting the current turn or starting a new
one. Choose the next agent, the implementer (including edit passes), or independent review and
arbitration. Each message belongs to the exact approved plan version and slice. It can refine the
approach within approval, but cannot change scope, commands, requirements or acceptance, waive a
gate, or answer a pending structured question. Those changes still need revision or a structured answer.

At dispatch, the controller atomically removes matching messages from the queue and freezes them
in the step intent. Later messages wait for a later matching turn. You can cancel queued messages;
assigned messages cannot be withdrawn. The history says **Assigned to a step**, which is not proof
that a provider received or followed the guidance. Inspect the resulting work and review evidence.

The queue survives pause, restart and repairs within the same slice. Revision expires unassigned
messages. A message is at most 4,000 UTF-8 bytes; at most eight messages may be queued or assigned
to an active step. The screen retains the latest 24 historical messages plus active messages;
the journal retains the complete history. Queue and cancellation actions count as human interventions.

If messages remain with no agent turn scheduled before delivery, Grampus stops with
`GUIDANCE_PENDING` before any Git delivery. Cancel them and explicitly continue the same verified
attempt, or revise the plan for further work. Once delivery starts, new guidance is refused.
Recovery restores a frozen batch only when it proves no leaf operation dispatched. Completed
results are adopted without sending the message again; uncertain dispatch still requires recovery.

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
spend is never mistaken for the active context size. A conversation is resumed only when
a turn is known to have run on it (a completed turn or a context reading): a provider can
assign a conversation id and refuse the first turn without saving the conversation, so
resuming that id would only fail. Provider compaction within a
turn remains provider-managed. Reset decisions happen between settled operations,
never halfway through tools or uncertain recovery. Changed Codex dynamic toolsets
also require a fresh conversation so evidence tools are actually available.

Resumed prompts avoid repeating the complete brief and inline repository contents.
They contain the current slice, criteria, artifact, exact file policy and compact
failure/review feedback. Agents can read current source, changes, installed dependency
source and full check evidence on demand. Fresh contexts receive a bounded deterministic
handoff from recorded state; Grampus does not spend another model call generating a
summary. Every new verdict still applies to the current artifact.

A fresh context is where a prompt is largest: a repair after a context reset carries the
changed files and their diffs as well as the request. Every turn prompt shares one 256 KiB
budget, so it always fits both providers; content that does not fit is left to the
repository tools. A turn whose required content cannot fit (only possible without
exploration, or with an extreme request) stops before dispatch with
`PROMPT_BUDGET_EXCEEDED`, and no provider turn is spent. See
[REPOSITORY-CONTEXT.md](REPOSITORY-CONTEXT.md#budgets).

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
