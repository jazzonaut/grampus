# Dashboard

The dashboard is the main way to use Grampus. Run `grampus` after
[installing](INSTALLATION.md) (port 4317), or from a checkout double-click
`Grampus-Dev.cmd` or run `npm run ui` (port 4318; both build the server and the client first).
The command opens your browser on Windows and prints the link; keep its terminal open while
you work. The dashboard works in a normal browser or Orca's embedded browser. The footer shows
the version, channel, build and journal.

For daily Orca use, the [native Grampus plugin](ORCA.md) starts or reconnects to the
dashboard in the background with one command or assigned shortcut. No terminal needs
to remain open. Its **Stop Dashboard** command refuses while dashboard work is active.

Run `grampus ui --orca` to open the dashboard in Orca's embedded browser, or
`npm run ui -- --orca` from a checkout. `--no-open` suppresses navigation. If Orca
cannot open the page, the server stays available at the printed browser link.

While the dashboard is open, adopted local Orca worktrees display the task title,
current stage and slice on their cards. A new approval, question, block or recovery
state marks the worktree unread once per observation; polling does not keep marking
the same state unread and Grampus never clears your unread indicator. Waiting cards
use `todo`, active work uses `in-progress`, quality assessment, review and acceptance
use `in-review`, and verified final delivery uses `completed`. These are the default
Orca board status ids; a runtime that refuses them reports a card update problem.
The refresh interval is `orcaSyncIntervalMs` (five seconds by default).

**Open workspace in Orca** on an Orca task opens or reuses a browser tab with that task
inside its recorded workspace and brings it into view. Navigation remains available
during a run. The access token travels only in the local URL fragment and is removed
before the task route is displayed. No token is put on a worktree card. Desktop failures
are separate from task failures; card problems appear beside the navigation button.
Updates resume while the dashboard is open, including for tasks driven by the CLI.
With no dashboard running, cards retain their last observed state.

Orca remains a display and worktree host. Agents are still Grampus-owned supervised
processes. **Planned:** native Orca conversation and control integration.

## Screens

The sidebar lists **New task**, the overview, every task and planning conversation with its
status in words (and **No activity for N min** when a step has gone silent), and **Integration
health**. The header shows the integrations summary and links to the Health screen. Screens are
addressed in the URL fragment (`#/`, `#/new`, `#/tasks/<id>`, `#/planning/<id>`, `#/health`), so
Back, Forward and reload keep your place. Only the visible screen is polled (every 1.5 seconds,
paused while the tab is hidden); the overview is polled throughout because the header and
sidebar show it.

| Screen | Shows |
| --- | --- |
| **Overview** | **Needs your attention** first: every task or planning conversation waiting for you, most urgent first, with one sentence on why, the stop reason code and the actions that resolve it (actions that need a form link to their screen). Then integration health, tasks (status, stage, slice i of n, last activity, stall badge, usage headline with turns and interventions), planning conversations, recent verified deliveries and how many guided tasks run against the limit |
| **New task** | Repository folder (typed, or chosen from **Or choose an Orca worktree**, which lists local Orca worktrees grouped by repository with full paths when Orca answers), what should change, reference folders with **Suggest from task description**, planner and implementer (Codex or Claude; the other reviews), workspace (standalone Git worktree or local Orca worktree) and **Optional file hints**: **Suggest starting files** pins the commit and suggests paths, the repository map, the inventory digest and a search of the pinned inventory, 100 paths a page. **Start planning** shows "Preparing repository context" while the repository is inspected, then sends the first planning turn and opens the conversation. **Already have a guided plan?** imports plan JSON as an unapproved task |
| **Planning conversation** | Shared live communication graph with **Open full observability** for event inspection and replay, status and explanation, the discussion (Markdown), live planner progress with **Stop planning**, **Recover planning session** when an earlier planner still owns the session, pending questions with suggested answers, a message to refine the plan, the proposed plan with its digest and **Review for approval**, repository access with editable file hints and inventory search, reference folders with suggestions, exploration, MCP connections, reset and delete |
| **Task** | Summary header (slice, title, status, intended outcome, one-sentence explanation, next step: automatic, your decision or none, the controller's note with the stop reason code, stale-plan, stall and failed-action notices), the workflow strip, current activity with **Stop now**, the decision queue, results, measured usage, details on demand, plan revision and task management |
| **Integration health** | Overall health with its reason, when it was checked and whether a new check is due, version-change warnings, and per integration its version (and SDK version), whether it is required and a status per capability with detail. **Check again** reruns the checks |

## Plan a task

1. Choose **New task**, enter an existing repository folder and describe the change. With Orca
   running, **Or choose an Orca worktree** fills the folder with a worktree's full path.
2. Choose **Start planning**. The planner explores the repository itself through read-only
   tools at the pinned commit; it cannot edit files or run commands. The planning card shows
   what the planner is doing, elapsed and last-activity times, repository actions, MCP requests
   and its latest requests. Optional file hints point it at useful starting files;
   **Update file hints** invalidates an earlier proposal without starting a turn.
3. Answer consequential questions, or ask for revisions, until the proposal describes the right
   outcome and examples. Suggestions fill the answer box for editing before you send. Discussion
   and plan text render Markdown; commands, file contents and expected output stay literal.
4. Add outside repositories or plain folders under **Reference folders**. Paths in the
   description are detected, and the planner can suggest more with reasons, but a suggestion
   grants nothing until you add it and choose **Update reference folders**. References stay
   read-only throughout the task. **MCP connections** shows each provider's configured
   connections, such as Linear.

Planning uses subscription usage only when you start or send a turn. Naming costs nothing: the
sidebar shows a short title from the first sentence of the description until the planner
proposes a plan, then the plan's title.

The planner covers the whole request and may split it into 1 to 64 ordered slices, each with
its own file scope, checks and commit message. The final slice verifies every criterion. Review
the full sequence rather than narrowing scope because a ticket is large.

## Approve

**Review for approval** freezes the proposal as an unapproved task and opens it. Its plan
(under Details) shows the outcome, repository access, criteria, approach, base commit,
workspace, agents and models, the workflow, review and quality pass policies, preparation,
every slice's file actions, exact commands (executable, each argument and the argument array),
timeouts, exact expected output and delivery message. The planner does not choose quality
passes: a new plan gets the configured default (the simplification lens), and **Revise this
task's plan** changes them before approval. Generated checks need your judgement: Grampus
syntax-checks generated inline Node checks but cannot tell whether a check proves the right
thing.

The approval card names the exact plan version and digest you approve. Approving a plan in
automatic mode (the default) starts the run straight away, unless the
[runner pool](#parallel-tasks) is full: the plan is then approved, the page says
**Waiting for a free runner slot** and the task waits as **Ready to continue**.

## Run

The task runs [automatically within the approved scope](WORKFLOW.md): preparation,
implementation and any edit quality passes, validation, independent review with an assessment of
each selected quality lens, acceptance and a verified local commit per slice. Questions, scope
errors, exhausted repair allowances and operational failures stop for attention with the reason
shown.

- **Workflow strip:** each stage in order (quality passes come from the plan) with its state in
  words and who established it: *verified by Grampus* (checks, acceptance, the commit), *agent
  reported* (implementation, edit passes, the review and its lens verdicts) or *your
  assessment*. A stage that stopped before a result is Unknown, never passed.
- **Current activity:** what is running, elapsed and last-activity times, repository actions,
  MCP requests and file change requests, and the latest agent requests. Agent activity
  describes what the agent asked for; checks and retained evidence establish results. There
  are no percentages.
- **No activity for N min:** when a running agent turn or check has journaled nothing (no
  output, usage, tool or other event, and for a check no growing output log) for
  `stallWarningMs` (10 minutes by default, see [CONFIGURATION.md](CONFIGURATION.md)), the task
  shows this badge and a notice, and the timeline records one "possibly stalled" entry per
  silence. Nothing is stopped: wait if the step is slow, or use **Stop now** if it is hung.
- **Results:** unresolved problems, criteria coverage, checks with a compact failure summary,
  the exact command and **Read stderr** / **Read stdout** (loaded in pages on request), review
  findings, quality lens verdicts and recorded assessments, edit passes and local commits.
- **Live changes:** a visible changed-file list and selected unified diff against the task's pinned
  base, including delivered slices plus current staged, unstaged and untracked work. Observations
  refresh every `liveChangesIntervalMs` (five seconds by default), independently of journal updates,
  while the task page is visible. These reads spend no model tokens and establish no gate evidence.
  Reverted selections clear. Large previews explicitly show truncation; unavailable reads warn that
  any retained preview is stale. Binary changes show Git's binary notice.
- **Guidance:** queue a message for the next agent, implementer/edit pass, or independent review
  and arbitration, within the approved plan. The draft survives stage changes. Messages show queued,
  assigned, cancelled or expired status and can be cancelled until assignment. Assignment confirms
  only a saved step intent, not provider receipt or compliance. No extra turn starts. If no matching
  turn remains, delivery stops until you cancel the queue or revise the plan. The panel shows up to
  24 historical messages plus active messages; the timeline retains the full history.
- **Automatic repairs:** the current slice's shared allowance, used and remaining rounds, and recent
  controller decisions with their trigger, progress assessment, remaining allowance and evidence
  identities. The timeline keeps the full history. Review progress is labelled as an agent assessment.
- **Task spending allowance:** used and remaining task-wide agent turns and the optional token
  threshold, including linked planning and every plan version. Unknown token headroom is explicit.
  These limits stop the next agent turn; active work settles normally and may exceed the token
  threshold. Budget stops offer plan revision and fresh approval. A retry cannot reset spend.
- **Measured usage:** per-provider tokens (input, output, cache read and cache write) and
  estimated cost, how complete each figure is and the last observation time, then turns,
  failed and stopped turns and wall time per stage, and a line with total turns, repair attempts
  and human interventions after approval. Unknown values show as Unknown, never 0; **partial**
  or a `+` marks a lower bound. Billed cost is always unknown.
- **Token usage headline** (task, planning and overview): every token counted once, as the token
  allowance counts it (Codex input already includes cache reads; Claude cache reads and writes are
  added), followed by how many of them were cache reads, which are usually billed at a fraction of
  other input. An agent turn re-sends its growing conversation on every model call, so most of a
  long exploring turn is cache reads.
- **Details:** the timeline (latest entries first, **View full timeline** pages through the
  whole history), the plan, approval and artifact digests, retained changes (each file's exact
  before and after), the report (**Load report** renders it, **Download Markdown** saves it),
  workspace and delivery, read-only references and repository exploration.

In supervised mode the task also stops for file authorization (the card lists each file with
its action and exact current content, and the repository instructions) and a quality
assessment, with forms for both. The assessment form lists each selected lens; your outcome and
summary are recorded for every lens. Without selected lenses there is no assessment stop.

## Parallel tasks

Up to `maxConcurrentTasks` guided tasks (2 by default, at most 4, see
[CONFIGURATION.md](CONFIGURATION.md)) run at once, each in its own worktree; they may share a
source repository. The home screen shows how many slots are taken, for example **1 of 2 guided
tasks running**. A task stopped for recovery keeps its slot until **Recover saved work** settles
it. While every slot is taken, **Continue task**, **Authorize these files and start**, **Refresh
file checkpoint**, the assessment and answer forms, **Retry**, **Retry preparation** and **Rerun
checks** are disabled with the reason, for example **2 of 2 tasks are already running**. An action
sent anyway (from a page shown before the pool filled) is refused before any worker starts and the
page shows a calm **Waiting for a free runner slot** notice; nothing changed. Nothing is queued:
continue the task once another finishes or is stopped. Approval, recovery, revision, releasing a
reservation and stopping are never limited, because they start no agent turn or check.

## Controls

Every button and form is an action the server offers for the state on screen, with its label,
consequence and, when unavailable, why. Forms are generated from the server's description of
the fields.

| Control | Effect |
| --- | --- |
| **Pause after this step** | Lets the current operation finish and settle, then stops before starting another. **Continue task** resumes the same attempt with its files, conversations and evidence. A failure, question or uncertain settlement keeps its own reason |
| **Stop now** | Requests settlement of active work. It does not claim processes have already exited |
| **Retry repair** | Starts a fresh attempt, keeping files and resuming eligible conversations. Use it after staging files mid-run |
| **Rerun checks** | Shown only when a validation or acceptance check stopped for an infrastructure reason (timeout, interruption, lost output, abnormal exit or runner error) on an unchanged change. Runs the same check again with no agent turn and no new attempt; refused if the workspace changed since |
| **Retry preparation** | Reruns a failed preparation step in the same attempt |
| **Recover saved work** | Runs the same conservative receipt checks as `task-recover` after a controller exits |
| **Revise this task's plan** | At a settled point, edit the name, outcome, approach, workflow mode, repair, task spending and conversation limits, review repairs and arbitration, quality passes (chosen and ordered), or (advanced) the plan JSON with files, checks, criteria and remaining slices. Needs fresh approval |
| **Release unused reservation** | Clears a failed standalone worktree reservation once Git exit and absence of files are confirmed. Deletes nothing |
| **Reset task** | Restarts planning from the original request in a fresh conversation and baseline. The old task is hidden |
| **Delete task** | Hides the task. Workspace files, commits and history are kept |

Reset and delete ask for confirmation on the page and refuse while work is live or uncertain.

Nothing is optimistic. After an action is accepted the page says it was requested and keeps its
buttons disabled until the server's state reflects it; if nothing changes for 20 seconds it says
so, without repeating the action. Stale pages cannot act: every action carries the decision key
or turn key of the state you inspected, so a page cannot approve a replaced plan, authorize
different files or answer a different question round. When the server refuses an action as
stale, the page reloads the current state and explains calmly that nothing was done.

Refreshing or reopening the page starts no provider calls, checks or Git writes. Actions run in
separate worker processes, so restarting the dashboard does not stop them and is not evidence
that they stopped. A failed action is shown on the task or planning conversation and recorded in
its journal as `dashboard.action_failed`, so the reason survives a dashboard restart: until the
task moves on, or the planning conversation has a later turn or change, the page still shows the
latest failure. After a restart, open the newly printed link.

A task whose journal records cannot be read (for example a retained snapshot missing from the
journal) does not take the overview down. It is listed as **Cannot be read** with an unknown status
and a **Needs your attention** item naming what failed (such as a missing snapshot record), and the
dashboard logs a redacted line naming the task. Its own page stays unavailable until the journal is
repaired; inspect the journal before acting on it.

## Integration health

The header shows **Integrations healthy**, **Integrations need attention** or **Integrations
not checked yet**; it links to the Health screen with each integration (Codex, Claude, Git,
Node, Windows PowerShell and Orca), its version and a status per capability: executable,
version, sign-in, handshake, MCP and, where relevant, SQLite or the native supervisor.
Inference is always shown as not tested, because health checks never send a turn. **Check
again** reruns the checks (a few seconds; no inference). The dashboard checks by itself when it
starts and before a guided run if the stored result is older than `healthCheckIntervalMs`
(10 minutes by default).

A warning such as "Codex changed from 0.162.0 to 0.163.0 since the last successful delivery;
capabilities are untested on this version" means the provider program differs from the one
that last carried a task to a verified commit. Grampus does not block on it: run a small,
low-risk task first, watch for stops caused by protocol errors, and update the recorded protocol
fixtures if the provider changed its protocol ([ARCHITECTURE.md](ARCHITECTURE.md#health-and-stalls)).
The warning clears after the next successful delivery on the new version.

## Accessibility

Every control has a label, keyboard focus is always visible, and a skip link leads to the main
content. Status is never shown by colour alone: each status has an icon and words. Status
changes and action outcomes are announced to screen readers through live regions. Dense
evidence (plan, digests, changes, report, check output) is collapsed until you open it, and the
layout works at common laptop widths.

## Access and data

The server listens only on `127.0.0.1`. The startup link carries a per-launch access token in
the URL fragment; the browser keeps it in session storage and removes it from the address bar.
Every API request needs that token and the local origin. Pasting a fresh link into an open tab
takes its new token. The client is a bundle built from `web/` and served from `web/dist`; no
remote scripts, styles, fonts or icons are loaded, and the strict Content Security Policy
(scripts, styles and connections from the dashboard itself only) applies to every response.
Treat the full link as access to your local controller.

The dashboard reads a typed, versioned API under `/api/v1/` (overview, task, planning
conversation, timeline and retained changes) and acts through the existing action routes. The
server decides every status, label, explanation and available action; the client only draws
them ([ARCHITECTURE.md](ARCHITECTURE.md#dashboard-view-model-and-api-v1)).

The dashboard and CLI share the same journal. Use `--db <path>`, `--port <number>` and
`--no-open` to change the journal, port or browser behaviour. Browsers refuse the Fetch
standard's blocked ports (such as 6000 or 10080), so the dashboard refuses to start on one, and
when it chooses a free port (`--port 0`) it takes another whenever the system offers a blocked one. A development checkout needs its
`web/dist` (built by `npm run build`) and `src/process/native` folders alongside `dist`;
without `web/dist` the page explains how to build it while the API keeps running. Up to
`maxConcurrentTasks` guided tasks run at once per journal ([parallel tasks](#parallel-tasks)).
Advanced users can import an authored JSON plan from the new-task screen
([guided CLI](GUIDED-WORKFLOW.md)).

## Model profiles, metrics and comparisons

The sidebar's **Model profiles** screen edits named, fixed role assignments and supported reasoning
settings. Choose a profile on **New task**; inspect its effective assignments on the plan before
approval. Existing approved tasks retain their selected definitions when the catalogue changes.

Task pages show a run scorecard, per-role/model usage and explicit full JSON, compressed JSON and
metrics CSV downloads. Expand **Compare model profiles on this plan** to prepare sequential runs
from the same base. The **Comparisons** screen lists groups, their shared plan, run outcomes and
exact configurations. Approve the group, then run it. Questions and recovery use the individual
task's existing controls; return to the group to continue. The group pause control waits for the
active operation to settle before more work starts.

A comparison's completion means its variants have settled, including failures. Select a verified
preferred result manually after inspecting its changes. This choice does not integrate code.
**Inspect integration** previews the source branch and selected commit; a separate confirmation
fast-forwards a clean branch still at the comparison base. An advanced branch needs manual
integration. Unknown usage and subscription allowance remain explicit. Exported comparison JSON
retains shared planning once and includes complete recorded details for every variant, beyond the
bounded dashboard previews. See [WORKFLOW.md](WORKFLOW.md#model-profiles-and-comparisons).
