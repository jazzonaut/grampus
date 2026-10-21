# Adaptive local work

Grampus approves the intended outcome and acceptance requirements, then lets the implementing
agent choose how to deliver them. The approach is provisional. File lists are optional suggestions,
not permissions, and planning does not have to predict helper filenames, setup commands or debugging
steps. A material change to the agreed outcome, exclusions or acceptance requirements still needs a
decision and a revised approval.

One coherent deliverable needs no `brief.slices`; its single execution entry uses every task
criterion. Multiple deliverables reference exact task criterion strings from `brief.criteria`, with
no duplicates within a slice, and together cover every criterion. The final slice verifies them all.
Implementation detail belongs in the provisional approach, rather than independent slice criteria.

If a completed planner reply contains an invalid plan, Grampus supplies the validation error and
allows one fresh correction turn. The planner must preserve the requirements or ask a consequential
question. A repeated invalid plan stops with its error visible; an explicit continuation includes
that feedback. Interrupted, failed or uncertain provider calls are never automatically repeated.

## Candidate workflow

1. Approve the brief, criteria, provisional approach, controller verification commands, model
   assignments, resource allowances and local delivery.
2. Create the worktree and capture its baseline. An optional approved bootstrap command runs here.
3. Let the agent investigate, edit, install dependencies, generate files, format, test and debug with
   native tools. It can create directories, rename files and add binary assets without individual
   file grants. It completes selected edit quality passes as part of this work.
4. Continue unfinished `kind=message` turns on the same execution. They do not submit the attempt or
   spend repair rounds. A consequential `kind=question` waits for an answer. Only `kind=candidate`
   submits the current slice for controller verification.
5. Capture the candidate. Run declared mechanical readiness, behavioural validation and every
   acceptance check in order against those exact contents. The first acceptance failure returns
   ordinary failures to implementation within the shared repair allowance.
6. Independently review the candidate together with actual check and acceptance evidence. The reviewer
   checks correctness, task relevance, test quality and selected quality lenses. Concrete blockers
   return to implementation within the same shared allowance; repairs invalidate previous evidence.
7. Record the quality assessments and deliver the verified local commit. Continue the next slice or
   mark the task complete only after verified delivery.

The default automatic mode needs no per-file or per-command approval. The explicit supervised mode
still pauses for workspace confirmation and a human quality assessment. That confirmation grants
native execution rather than an exact file allowlist. Controller-owned Git delivery remains the
same in both modes.

## Native execution and ordinary failures

Codex implementation threads use native tools, `approvalPolicy: never` and
`sandbox: danger-full-access`. Claude uses the native `claude_code` tool preset with
`permissionMode: bypassPermissions`. No filesystem or command sandbox is provided. Planning and
independent review retain their read-only tool contracts. Subscription authentication, process
ownership, stop handling and confirmed shutdown are unchanged.

Explicit low-level `execution-implement` operations still support scoped file policies for
diagnosis and tests. Internal scoped diagnostic helpers are retained for probes and isolated
tests; native guided workers do not offer or require their receipts. Guided tasks always use
native candidate execution and never fall back to a scoped implementation when native execution fails.

The implementer runs its own setup, formatting and diagnostics. It receives the controller's final
verification commands for context, but these are not its command allowlist. Optional slice
`preparation` and `formatting` entries are suggestions for the agent; they are not automatically run
after a turn. Diagnostic families and their supplemental approvals do not govern native execution.
The worker never converts an unfinished native turn into failure by automatically running a formatter.
A missing proposed test file, failing command or different helper layout is work for the agent to
resolve. Agent check reports remain observations, never controller gate evidence.

Grampus owns HEAD, the branch, the index and repository instruction files. Agents are instructed to
leave those unchanged; settlement detects changes rather than approving a candidate against a moved
Git checkpoint. Pushing, publishing, deploying and external writes still need explicit authorisation.
Native commands run inside the supervised provider process tree; an uncertain process exit requires
recovery and is never automatically replayed.

## Verification and repair

Readiness checks are optional read-only format, lint and types commands. Their failures use the
approved per-slice readiness allowance. Behavioural validation, acceptance and blocking review share
the approved behavioural repair allowance. Spending survives retries and restarts. Task-wide turn
and token thresholds apply to progress turns too, so an agent that never submits a candidate cannot
continue indefinitely.

A submitted candidate is not success. Each check binds to the version, attempt, artifact and
repository instructions; every named acceptance check must pass. Acceptance observations must verify
behaviour, not just an exit status or invented success marker. The independent reviewer sees those
actual results before issuing a verdict. Later edits require fresh checks and review.

Infrastructure failures, unknown exits, mutating checks and unavailable evidence remain explicit
stops. No-progress and exhausted repair allowances stop for attention. Ordinary confirmed check
failures return to the agent in automatic mode; the agent may investigate and repair a defective test
with concrete evidence, but must not weaken a valid requirement to obtain a pass.

## Quality passes

Ordinary selected edit passes, such as refactor or documentation, are instructions for the implementer
before candidate submission, including after repairs. An explicit model assignment for an edit pass runs a separate native turn once per slice; otherwise passes do not
create separate turns. Edit-pass reports never claim independent evidence. Review lenses, such as simplification and naming, are assessed by the independent
reviewer against the verified candidate. A failed or missing required lens prevents delivery.

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
**Retry repair** and **Retry preparation** also work after the comparison has moved past a failed
member or completed. An explicit retry starts immediately when the comparison is idle, or queues
behind its active run and before the remaining profiles. Queued retries survive controller restarts;
duplicate clicks do not authorise additional attempts. A paused comparison needs **Run comparison**,
and human questions or recovery on the current run still need their normal decisions first.
Retries retain files, conversations, approval and repair usage. They do not reorder the approved
initial runs or replenish an allowance, and integration must not have been requested.
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
the usual `--db` journal selection. Schema 14 requires a fresh journal; other versions are refused
without migration. Development work does not update the installed application or its journal.

## Configuration

The policy is part of the approved plan, visible at approval and editable in
**Revise this task's plan**:

```json
"workflowPolicy": {
  "mode": "automatic",
  "readinessRounds": 5,
  "repairRounds": 5,
  "maxSessionTurns": 6,
  "maxContextTokens": 120000,
  "maxTaskTurns": 20,
  "maxTaskTokens": 0
}
```

These are the defaults for a new plan that omits the policy or some of its fields;
`defaultWorkflowPolicy` in `config.json` changes them for new plans only
([configuration](CONFIGURATION.md)).

`mode` defaults to `automatic`. `mode: "supervised"` adds workspace-confirmation and
manual quality assessment checkpoints and leaves failed checks for a manual retry (see
[the guided CLI](GUIDED-WORKFLOW.md#supervised-mode)).
Behavioural repair rounds accept 0–10, defaulting to five. Behavioural validation, independent review and acceptance
spend the same allowance for the current slice. It survives manual retry and restarts;
a new slice or revised plan gets a new allowance. An explicit retry authorises one further
attempt without replenishing automatic repairs. Infrastructure failures never spend it.

A new related review finding can be repaired automatically after earlier blockers are resolved.
The controller assigns stable identities to the preceding verdict's blockers, including failed
selected lenses. The reviewer returns `priorFindings`, one `{ id, status, evidence }` per identity,
with `status` either `resolved` or `unresolved`. Further automatic repair requires a changed
artifact and evidenced resolution of at least one earlier blocker, with a disposition for every
earlier blocker. Partial progress permits another repair within the existing allowance; delivery
still requires every blocker resolved. The same artifact, no resolved blockers or a claimed
resolution contradicted by the current verdict stops with `REVIEW_NO_PROGRESS`; missing, duplicate or foreign identities
stop with `REVIEW_PROGRESS_UNCONFIRMED`. These claims are agent evidence, not controller proof
of semantic correctness. Passing reviews must also account for prior blockers. All earlier
verdicts remain available to the reviewer.

`reviewPolicy` selects optional fresh arbitration only. A stalled review, missing progress
evidence or exhausted shared allowance can go to that approved arbitrator once. Arbitration
receives the artifact and full review history; an unresolved verdict stops.

Changing the agreed outcome, acceptance requirements, final controller commands or policy values uses
a plan revision and fresh approval. Changing local debugging commands, project files or the provisional
approach does not. The approval digest always covers the complete recorded plan.

Each failed check or blocking review records `guided.repair_decided` in the same transaction
as its state transition. It names the source, triggering result, execution, artifact, progress,
action and the relevant readiness or shared behavioural budget before the decision. Review dispositions remain in the linked session's
structured reply. This makes the choice to repair, arbitrate or stop inspectable alongside the
existing request/result, check and usage journals.

The current controller uses journal schema 14, including adaptive native execution, candidate submission,
readiness spending, model assignments, comparisons, pause, guidance and ordered acceptance checks. Journals from
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
approach, file choices and local commands within approval. It cannot change the agreed outcome or
acceptance requirements, waive a gate, or answer a pending structured question. Those changes still
need revision or a structured answer.

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
They contain the current slice, criteria, artifact and compact
failure/review feedback. Agents can read current source, changes, installed dependency
source and full check evidence on demand. Native implementers use their normal tools. Fresh contexts receive a bounded deterministic
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

## Execution efficiency

Native tools keep investigation and ordinary repair inside the agent's work loop. Grampus does not
parse test-runner grammars, reserve individual diagnostic attempts or force formatter invocations
against filenames guessed during planning. Final readiness, validation and acceptance remain
controller-run checks. Declared independent readiness checks can run together under
`maxReadinessConcurrency`; acceptance remains ordered.

Progress turns preserve the execution and provider conversation. Approved turn/context thresholds
rotate the provider conversation only between settled turns, keeping the current artifact, brief,
criteria, answered implementation questions and the latest implementation summary. The original
question text accompanies each answer; summaries remain untrusted observations. An oversized
handoff is refused before provider dispatch rather than silently dropping decisions.
Repairs create a new attempt and may resume the slice conversation.
Implementation and review never share a conversation.

Selected reference folders remain available through read-only Grampus tools during native
implementation, including their approved Git commit or folder digest. Native project commands
remain unrestricted. A native repair candidate does not require scoped diagnostic receipts;
the controller runs its full approved checks before accepting the repaired artifact.

Workflow timing still covers planning, execution, checks, waiting, recovery and delivery. Native
command output is retained through provider activity; commands are not individual controller check
receipts. Journal schema 14 requires a fresh journal. Other schema versions are refused without
migration; installed applications and their journals are separate from development work.
