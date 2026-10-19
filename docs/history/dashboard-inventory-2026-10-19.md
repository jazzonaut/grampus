# Dashboard inventory, 19 October 2026

A point-in-time inventory of the legacy dashboard client (`src/ui/app.js`, `index.html`,
`markdown.js`) taken before the Vue client replaces it. It is the parity checklist for that
step: every screen, piece of information and action below must exist in the new client, or be
dropped deliberately with a reason. The right-hand column names where the server-side view
model (`src/server/view-model/`, served under `/api/v1/`) now provides it.

Legend for the source column: **v1** = in a v1 DTO; **route** = existing route the client
calls directly; **client** = presentation only (layout, formatting, local state), no rule.

## Global shell

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Access token | Taken from the URL fragment into session storage, fragment stripped; `hashchange` accepts a fresh link; every call sends `Authorization: Bearer` | client (`web/src/api/client.ts`) |
| Error banner | Dismissible `role="alert"` banner with the last request error | client; v1 errors carry `{ error: { status, code, message, issues } }` |
| Skip link, loading and noscript text | `index.html` | client |
| Polling | `/api/state` every 1.5 s, plus the open task; render only when the signature changes; preserve typed text, focus, selection, open `<details>` and timeline scroll across renders | client; v1 responses carry `revision` |
| Selection memory | Selected screen and item kept in session storage | client |
| Elapsed timers | `data-elapsed-since` ticks every second | client, from `startedAt` / `lastActivityAt` |
| Stale-tab safety | Every button and form carries the decision key, digest and version it was rendered with | v1 `ActionView.expected` and `request.body` |

## Sidebar

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Brand and **New task** button | Opens the new-task screen | client |
| Task list | Title, status dot and label (fixed status names), stall badge "No activity for N min" | v1 `OverviewV1.tasks` (`statusLabel`, `stalled`) |
| Planning list | Unconverted kickoffs: title (or request start) and session phase label | v1 `OverviewV1.planning` |
| Footer | "WINDOWS ALPHA", version, channel, build id with built-at tooltip, product lines | v1 `OverviewV1.application` |

## Header

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Breadcrumb | Workspace / Overview, New task, Planning or Task | client |
| Health card | "Integrations healthy / need attention / not checked yet"; warnings; "Checked N ago · due for a new check"; per integration: status, version, capabilities with status names and detail when not healthy or untested; **Check again** (`GET /api/health?refresh=1`) | v1 `OverviewV1.health`; route for Check again |
| Local controller label | "Local controller · Windows alpha" | client |

## Welcome (no selection)

Intro text, **Start a task** and three cards (Plan, Work, Deliver). Static copy: client. The
new home screen replaces it with the overview: attention queue, tasks, planning and recent
deliveries (v1 `OverviewV1`).

## New task (kickoff form)

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Repository folder, request text | Required fields | client, posts `POST /api/kickoffs` |
| Reference folders | Textarea, one path per line; **Suggest from task description** (`POST /api/references/suggest`) lists suggestions with reasons to add | route |
| Provider choice | Codex or Claude plans and implements (the other reviews) | client form, route |
| Workspace adapter | Standalone Git worktree or local Orca worktree | client form, route |
| Optional file hints | **Suggest starting files** (`POST /api/repositories/inspect`): pinned file count, selected starting paths, repository map with directory counts, inventory digest | route |
| File search | `POST /api/repositories/files` with offset paging (Previous/Next 100), match count, add a path to the hints | route |
| Start planning | Creates the kickoff, selects it and sends the first planning turn with its turn key; shows "Preparing repository context" progress meanwhile | route, then v1 `KickoffDetailV1.actions` |
| Import plan JSON | `POST /api/tasks` with an authored plan, opens the task | route |
| Side cards | "Before work begins" copy | client |

## Planning conversation

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Status badge | Session phase label, or Working while active | v1 `status`, `statusLabel`, `explanation` |
| Discussion | Messages with author (You or provider); answers JSON shown as plain lines; a plan reply replaced by "I've prepared a plan for …"; request shown when there are no messages; Markdown rendering | v1 `messages` (kind `message`, `answers`, `proposal`), `request` |
| Errors | Kickoff error and job error notices | v1 `error`, `actionError` |
| Live progress | Title by stage (connecting, working, responding, finishing, stopping), activity line, repository and MCP counts, last four tool labels, elapsed and last-activity times | v1 `activity` |
| Stop planning | While a run is recorded; "Stop requested…" once asked | v1 action `stop-planning` |
| Recover planning session | When the earlier planner still owns the session | v1 action `recover-planning` |
| Questions | Prompt (inline Markdown), suggestion buttons that fill the answer box, required textarea per question; **Send answers and continue** | v1 `questions`, action `plan-answer` with form fields |
| Message form | "Refine the plan" (required once messages exist) or "Start planning"; **Send message** / **Prepare a plan** | v1 action `plan-message` |
| Review for approval | When a proposal exists, no error and the session is idle | v1 action `prepare` (`{ digest }`) |
| Open task | After conversion | v1 `taskId` |
| Proposed plan card | Full plan (see Plan card below) | v1 `proposal.plan` |
| Manage task | Reset and Delete with confirmations; disabled while active or uncertain; hidden after conversion | v1 actions `reset`, `delete` |
| Reference folders | Editable textarea, suggestion buttons with reasons, **Update reference folders** (invalidates the proposal) | v1 `references`, `referenceSuggestions`, action `update-references` |
| Repository exploration | Number of read/search/list calls and recently read files | v1 `exploration` |
| Repository access | Repository, base, provider, workspace adapter; files supplied initially; editable starting hints with search; **Update file hints** | v1 `repository`, `base`, `provider`, `adapter`, `context`, action `update-context`; search is a route |
| MCP connections | Connected servers with tool counts | v1 `integrations` |

## Plan card (draft approval, proposal and "Approved outcome and execution plan")

Outcome, repository access summary and initial files, acceptance criteria, approach,
repository, base commit, workspace path, agents and models ("No automatic agent time
limit"), workflow policy sentence, review policy sentence, quality passes (title, lens or
edit, id, instructions), plan-level preparation command and timeout, retained revision
checkpoint, and per slice: title, approach, criteria, files to edit, create and delete,
slice preparation, validation and acceptance (name, timeout, exact command with executable,
each argument and the argument array), exact expected stdout (JSON escaped), additional
acceptance observations, delivery mode and message. Source: v1 `PlanView` (policy sentences
are server text: `workflowSummary`, `reviewSummary`, `qualitySummary`).

## Task page

| Item | Legacy behaviour | Source |
| --- | --- | --- |
| Eyebrow and title | "Task / Slice i of n", task title, status badge | v1 `header.slice`, `header.title`, `header.status` |
| Workflow steps | Plan, Prepare, Files, Implement, Quality passes, Prepare checks, Validate, Review/Assess (order by mode), Accept, Deliver with done/active marks computed in the client | v1 `workflow` (`StageView` with state, evidence source, lens items) |
| Status card | Status label, note in UI language (CLI names replaced: `humanNote`), job error, stall notice | v1 `header.statusLabel`, `explanation`, `note`, `actionError`, `stalled` |
| Progress card | Stage title and sentence (repair, review repair, arbitration variants), activity, running check name, repository/MCP/file-change counts, recent tool labels, elapsed since the step started, last activity | v1 `activity` |
| Stop | "Stop now" while a worker runs; "Request stop" when ownership remains | v1 action `stop` |
| Recovery | Notice plus **Recover saved work**, **Release unused reservation** (Git, workspace stage, reservation needing recovery), **Request stop** | v1 actions `recover`, `release-workspace`, `stop` |
| Stale plan notice | "The approved plan is stale…" | v1 `header.stale`, `explanation` |
| Draft | Approval text, version and digest, **Approve and start** (automatic) or **Approve this plan** | v1 action `approve`, `details.approval` |
| Ready | **Continue task** | v1 action `run` |
| File authorization | Instruction text, scope error, **Authorize these files and start** (disabled with scope error), **Refresh file checkpoint**; scope JSON, repository instructions, file contents of the retained snapshot | v1 actions `authorize`, `refresh-checkpoint`; `details.scope` |
| Quality assessment | Lens list with instructions, outcome select (passed, failed, skipped), summary, **Record assessment and continue**, **Revise implementation**, client check that an outcome is chosen | v1 action `assess` (form), `retry` labelled "Revise implementation" |
| Answers | Same question form as planning | v1 action `answer` (form) |
| Blocked: preparation | **Retry preparation** | v1 action `retry-preparation` |
| Blocked: rerunnable check | Reason code, **Rerun checks** then **Retry repair** | v1 actions `rerun-checks`, `retry` |
| Blocked: other | Scope-specific or generic text, **Retry repair** | v1 action `retry`, `header.explanation` |
| Complete | Delivered text, **Download task report** | v1 action `report`, `header.nextStep` |
| Repository exploration | Calls and recently read files | v1 `details.exploration` |
| Retained changes | Per changed file: before and after content with encodings | v1 `details.changes` (paths) and `GET /api/v1/tasks/:id/changes?path=` |
| Review findings | "Independent review findings" or "Earlier review findings to address": severity, description, evidence | v1 `results.findingsTitle`, `results.findings` |
| Quality passes | Edit passes with "no changes needed" or "changed the files"; reviewer lens verdicts with summary and findings; recorded assessments with source (independent reviewer or your assessment) | v1 `results.qualityEdits`, `results.lenses` |
| Checks | Per check of the slice: name, phase, compact issue, error, exact command, **Read stderr** / **Read stdout** pages with First and Next page and character range | v1 `results.checks` (`outputPath`); pages from `GET /api/tasks/:id/check-output` |
| Report | **Load report** (rendered Markdown) and **Download Markdown** | route `GET /api/tasks/:id/report`; v1 `details.reportPath` |
| Timeline | Pinned card with the latest three entries, live activity line, **View full timeline (N)** / **Show recent activity**, local times, event type as words, note in UI language | v1 `details.timeline` and `GET /api/v1/tasks/:id/timeline` (summaries, notes, reason codes, paging) |
| Measured usage | Per provider: input, output, cache read, cache write, estimated cost with "partial" marks, Live/Partial/Complete badge, sessions measured, "Billed cost: unknown", last observation time; by stage table with turns, failed and stopped turns, wall time with `+` for lower bounds; totals line with turns, unsettled turns, repair attempts and human interventions; footnote | v1 `usage` |
| Revise this task's plan | Hidden while live, pending or recovering; title, outcome, approach, workflow mode, check repair allowance (0 to 5), session turns (1 to 50), context tokens (8000 to 1000000), review repair rounds (0 to 2), arbitrator, quality pass ids with the available list, advanced plan JSON; client assembles the plan | v1 action `revise` with a generic form: each field names its JSON pointer in the body, bounds and options come from the server |
| Manage task | Reset and Delete with confirmations, disabled while live or uncertain | v1 actions `reset`, `delete` (`confirm`, `disabledReason`) |
| References | Read-only reference folders with file counts and base | v1 `details.references` |
| Workspace and delivery | Workspace path, implementer, reviewer, version, "Local only", deliveries with commit | v1 `details.workspace`, `details.plan`, `results.commits` |
| MCP connections | Connected servers with tool counts | v1 `integrations` |

## Business rules the legacy client duplicated

Each now has one server-side home:

- Status names and labels (`names`) and health status names: `view-model/status.ts`, `view-model/health.ts`.
- `humanNote` (CLI command names to UI language) and control-character stripping: `view-model/status.ts`.
- Review repair allowance (`reviewRepairRounds`, mirrored in the client): `view-model/plan.ts` uses the domain function.
- Automatic versus supervised wording and button labels: `view-model/actions.ts`, `view-model/plan.ts`.
- Which action applies to which status, stage and liveness (taskAction, revisionCard, managementCard, kickoffPage): `view-model/actions.ts`.
- Rerun-checks eligibility (client read `view.rerun`): `view-model/actions.ts` from `rerunChecksIneligibility`.
- Workflow step order by mode and done/active computation: `view-model/workflow.ts`.
- Stage activity titles and sentences: `view-model/status.ts` (`stageActivity`).
- Kickoff message rewriting (answers JSON, plan replies): `view-model/kickoff-detail.ts`.
- Usage completeness badges and lower-bound marks: `view-model/usage.ts`.
- Assembling a revised plan from form fields: the revision form's field targets (JSON pointers).

## Not yet in the v1 API

- Journaled planning `dashboard.action_failed` events after a dashboard restart (`KickoffDetailV1.actionError` shows the in-memory worker failure, as the legacy client did).
- Pending client-side state: "Inspecting repository…" before a kickoff exists is client state.
- Health refresh, repository inspect, file search, reference suggestion and report text stay on their existing routes.
