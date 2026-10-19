# Dashboard

The dashboard is the main way to use Grampus. Run `grampus` after
[installing](INSTALLATION.md) (port 4317), or from a checkout double-click
`Grampus-Dev.cmd` or run `npm run ui` (port 4318). The command opens your browser on
Windows and prints the link; keep its terminal open while you work. The dashboard
works in a normal browser or Orca's embedded browser. The footer shows the version,
build and whether this is an installed or development copy.

## Plan a task

1. Choose **New task**, enter an existing repository folder and describe the change.
2. Choose **Start planning**. The planner explores the repository itself through
   read-only tools at the pinned commit; it cannot edit files or run commands. The
   planning card shows connection status, elapsed time, recent reads and searches,
   and MCP requests. **Optional file hints** let you point it at useful starting
   files; **Update file hints** invalidates an earlier proposal without starting a turn.
3. Answer consequential questions in the discussion, or ask for revisions, until the
   proposal describes the right outcome and examples. Suggestions fill the answer box
   for editing before you send. Discussion and plan text render Markdown; commands,
   file contents and expected output stay literal.
4. Add outside repositories or plain folders under **Reference folders**. Paths in the
   description are detected, and the agent can suggest more with reasons, but a
   suggestion grants nothing until you add it and choose **Update reference folders**.
   References stay read-only throughout the task. **MCP connections** shows each
   provider's configured connections, such as Linear.

Planning uses subscription usage only when you start or send a turn. A separate
short turn names the task for the sidebar; if it fails, the sidebar uses the plan
title or the start of the description.

The planner covers the whole request and may split it into 1 to 64 ordered slices,
each with its own file scope, checks and commit message. The final slice verifies
every criterion. Review the full sequence rather than narrowing scope because a
ticket is large.

## Approve

**Review for approval** freezes the proposal as an unapproved task. Check its outcome,
criteria, file actions and contents, executables and arguments, expected output,
agents, command timeouts, pinned base, workflow policy, quality passes and delivery messages.
The planner does not choose quality passes: a new plan gets the configured default
(the simplification lens), and **Revise this task's plan** changes them before approval.
Generated checks need your judgement: Grampus syntax-checks generated inline Node
checks but cannot tell whether a check proves the right thing.

Approving a plan in automatic mode (the default) starts the run straight away.

## Run

The task runs [automatically within the approved scope](WORKFLOW.md): preparation,
implementation and any edit quality passes, validation, independent review with an
assessment of each selected quality lens, acceptance and a verified local commit per slice. Questions, scope errors, exhausted
repair allowances and operational failures stop for attention with the reason shown.

- **Progress:** the current step, elapsed and last-activity times, repository reads,
  MCP requests and file change requests. Agent activity describes what the agent
  asked for; checks and retained evidence establish results.
- **Failures:** a compact issue summary with the failing test or diagnostics. Full
  output is collapsed and loaded in pages with **Read stdout** and **Read stderr**.
- **Timeline:** pinned while scrolling, showing the latest entries. **View full
  timeline** expands the history.
- **Evidence:** findings, quality lens assessments and edit passes, outputs, retained
  changes, local commits and a downloadable Markdown report built from the journal.
- **Measured usage:** per-provider tokens and estimated cost, session coverage and the
  last observation time. Partial or missing values are marked; estimates never imply
  billed cost.

In supervised mode the task also stops for file authorization and a quality assessment,
with forms for both. The assessment form lists each selected lens; your outcome and summary
are recorded for every lens. Without selected lenses there is no assessment stop.

## Controls

| Control | Effect |
| --- | --- |
| **Stop now** | Requests settlement of active work. It does not claim processes have already exited |
| **Retry repair** | Starts a fresh attempt, keeping files and resuming eligible conversations. Use it after staging files mid-run |
| **Rerun checks** | Shown only when a validation or acceptance check stopped for an infrastructure reason (timeout, interruption, lost output, abnormal exit or runner error) on an unchanged change. Runs the same check again with no agent turn and no new attempt; refused if the workspace changed since |
| **Retry preparation** | Reruns a failed preparation step in the same attempt |
| **Recover saved work** | Runs the same conservative receipt checks as `task-recover` after a controller exits |
| **Revise this task’s plan** | At a settled point, edit outcome, approach, repair policy, quality passes (ids in order), or (advanced) files, checks, criteria and remaining slices. Needs fresh approval |
| **Release unused reservation** | Clears a failed standalone worktree reservation once Git exit and absence of files are confirmed. Deletes nothing |
| **Reset task** | Restarts planning from the original request in a fresh conversation and baseline. The old task is hidden |
| **Delete task** | Hides the task. Workspace files, commits and history are kept |

Reset and delete ask for confirmation and refuse while work is live or uncertain.
Stale pages cannot act: every decision carries the state you inspected, so a page
cannot approve a replaced plan, authorize different files or answer a different
question round.

Refreshing or reopening the page starts no provider calls, checks or Git writes.
Actions run in separate worker processes, so restarting the dashboard does not stop
them and is not evidence that they stopped. After a restart, open the newly printed
link and select the task.

## Access and data

The server listens only on `127.0.0.1`. The startup link carries a per-launch access
token in the URL fragment; the browser keeps it in session storage and removes it
from the address bar. API requests need that token and the local origin. No remote
scripts or assets are loaded. Treat the full link as access to your local controller.

The dashboard and CLI share the same journal. Use `--db <path>`, `--port <number>` and
`--no-open` to change the journal, port or browser behaviour. A development checkout
needs its `src/ui` and `src/process/native` folders alongside `dist`. One guided task runs at a
time per journal. Advanced users can import an authored JSON plan from the new-task
screen ([guided CLI](GUIDED-WORKFLOW.md)).
