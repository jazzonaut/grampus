# Local task dashboard

Run `grampus` after [installing a snapshot](INSTALLATION.md). Its dashboard uses
port 4317 and task data separate from development. The footer identifies the
version, build and installed/development mode; `grampus update` installs a fresh
snapshot explicitly.

For development, double-click `Grampus-Dev.cmd` in the checkout, or run `npm run ui`. It builds the
application, starts the local controller and opens your browser on Windows.
Keep the launcher terminal open while using Grampus. The dashboard works in a
normal browser or Orca's embedded browser.

The developer checkout needs Node 24 or later, Git, `npm ci`, and existing Codex
and Claude subscription logins. It supports Windows 10 or later. This is the
functional alpha interface. The per-user installer uses existing Node.js and CLI
dependencies; a bundled runtime and published release downloads remain future work.

Choose **New task**, enter the repository folder and describe the desired change.
Choose **Start planning** directly. Agents search and read the relevant repository
files themselves; **Optional file hints** offers suggested starting files and a
paginated inventory search if you want to point them at useful code. Planning reads
the pinned commit and cannot edit files or run commands. The exploration card shows
completed tool calls and recently read files. Implementation and independent review
also have read access, separately from the exact approved file changes. See
[repository context and scale](REPOSITORY-CONTEXT.md) for behavior and limits.
Consequential questions appear in the discussion. Answer them, or ask
for revisions, until the proposed plan describes the right outcome and examples.
Discussion messages, plan descriptions and loaded reports render Markdown, including
lists, tables, links and code blocks. Questions and clickable suggestions support
inline formatting; choosing a suggestion fills its answer box for editing before
submission. Commands, file contents and expected output remain literal text.
Planning consumes subscription usage only when you explicitly start/send a turn.
Starting planning also requests a short task name from the selected provider in a
separate background turn, using only the description and no tools. The name is
saved in the journal and used in the sidebar and subsequent task plan. Naming
runs at most once per conversation and does not affect planning questions or
progress. If it fails, times out, or planning finishes first, the sidebar uses the
proposed plan's title when available, otherwise the start of the description.
Starting planning immediately shows repository preparation, followed by the agent's
connection and response status, elapsed time, recent repository reads/searches and
MCP requests. Activity comes from the current planning turn; no percentage is
estimated. Elapsed and last-activity times keep updating between agent events, and
saved activity remains visible if you leave and return during the turn.
The planner covers the full requested task and can propose 1–64 ordered slices.
Larger tickets are split into independently verifiable deliveries, each with its
own file scope, checks and commit message. The final slice verifies every task
criterion, including earlier slices and integration. Review the complete sequence
before approval; a ticket's size alone should not prompt you to narrow its scope.

Planning, implementation, review and arbitration run until the agent finishes or
you choose **Stop**. Elapsed time alone never stops a guided agent. Legacy time
limits remain in saved approval records but are no longer enforced for agents.
Validation and acceptance commands retain their approved deadlines.

During planning, use **Update file hints** to add missing files before sending the
next explicit turn. This invalidates an earlier proposal without starting inference.

Add outside repositories or plain folders under **Reference folders**. Paths in
the task description are detected, and agents can suggest additional paths with
reasons. Approve suggestions by adding them and choosing **Update reference folders**
before the next planning turn. References are read-only throughout implementation
and review. Git references use committed content; plain folders use a checked
inventory. **MCP connections** shows the current provider's configured connections,
including Linear when configured. See the repository-context guide for limits.

**Reset task** restarts planning from the original request in a fresh conversation,
using a fresh baseline and reference snapshots. The prior task disappears from the
dashboard. **Delete task** removes it without starting another task. Both ask for
confirmation and preserve workspace files, commits and recorded history. Stop and
settle or recover active work first; stale-page actions are rejected. Reset is
different from retrying an implementation attempt.

Choose **Review for approval** to freeze the proposal as an unapproved guided task.
Review its outcome, criteria, exact context and file actions, executable/arguments,
expected output, agents, command timeouts, pinned base and local delivery message. Approve the plan,
then continue to prepare the isolated workspace. These remain separate actions.
Generated checks need human inspection for relevance. Generated CommonJS inline
Node checks are syntax checked without execution; other executables and scripts
are validated by their actual authorized execution. Grampus does not establish
semantic sufficiency automatically.

The dashboard presents the retained instructions and file contents before exact
file authorization. After implementation and validation, inspect the changes and
check output, choose an explicit simplification outcome and explain it. A pass
continues through independent review, acceptance and verified local delivery.
Questions, blocking findings and failed checks stop with an actionable checkpoint.
Retry starts a fresh attempt and preserves files. At a preparation failure,
**Retry preparation** resumes just that step in the same attempt. The planner
infers repository prerequisites and includes their commands in plan approval;
the dashboard retains preparation output separately from validation evidence.
No command-line arguments or
assessment JSON files are needed for these steps.

Progress, findings, outputs, retained changes, local commits and a task timeline
are shown alongside the current action. The timeline stays pinned while scrolling,
showing the latest three entries and current agent activity. **View full timeline**
expands the complete task history; **Show recent activity** returns to the compact
view. Execution shows the current step, elapsed and last-activity times, repository
reads, MCP requests and file change requests. These requests describe agent activity;
checks and retained evidence establish their results. Download the journal-derived
Markdown report for the complete evidence trail. Advanced users can still import a guided
JSON plan from the new-task screen or use the existing CLI.

**Stop now** requests settlement of the active task; it does not claim processes
have already exited. Planner turns also offer a stop control after startup.
Recovery runs the same conservative process/receipt checks as the CLI. Refreshing
or reopening a page starts no provider calls, checks or Git writes. A stale page
cannot approve a replacement plan, authorize a different retained snapshot, or
answer a different question round that happens to reuse question ids.
After a server restart, reopen its newly printed link and select the saved task.
Workers have their own process identities, so restarting the UI does not become
evidence of worker shutdown. Wait for a live worker; recover only after its exit.

The server listens only on `127.0.0.1`. Its startup link contains a per-launch
access token in the URL fragment; the browser retains it in session storage and
removes it from the address bar. API requests require that token and reject other
origins/hosts. No CDN scripts, remote assets or hosted services are used. Treat the
full startup link as access to your local controller. It is not a hosted dashboard.

The UI and CLI share the existing journal (by default `%LOCALAPPDATA%/Grampus/`).
Native receipts remain beside that journal. Use a different journal or port with
`npm run ui -- --db <path> --port <number>`; use `--no-open` to keep browser opening
manual. Preserve the checkout's `src/ui` and `src/native` alongside `dist` for this
developer distribution. One guided task at a time runs per journal; planning
sessions retain their existing session-level ownership rules.

Settled tasks now offer **Revise this task’s plan**. Update the outcome and approach,
choose a bounded review-repair allowance and optional fresh arbitrator, or expand the
advanced editor to change exact files, checks, criteria and remaining slices. Revised
plans retain files, commits and delivered slices, invalidate earlier evidence and need
fresh approval. Retained workspace changes appear before approval. Each repair still
requires file authorization and an explicit simplification assessment.
Earlier blocking findings stay visible while a repair awaits authorization or review.

**Measured usage** shows separate per-provider token and cost metrics, session coverage
and the last observation time. Claude cumulative snapshots are sampled every 15 seconds
during a turn and replaced by the final provider result. Live/interrupted observations
remain partial; missing values stay unknown and estimates never imply billed cost.
Older interrupted runs without observations cannot contribute measured totals.
Acceptance plans show JSON and file observations as well as legacy stdout
expectations. **Release unused reservation** can resolve a failed standalone creation
only after confirming Git exit and the absence of files and worktree registration;
it deletes nothing and waits for explicit continuation.

Remaining release work includes ordinary-project trials, live trials of these workflow
extensions, accessibility/browser coverage beyond the recorded tests, independent release
review and clean distribution validation. A local installer exists; no background
scheduler, automatic push or PR is enabled. See [guided workflow](GUIDED-WORKFLOW.md).
