# Local task dashboard

Double-click `Grampus.cmd` in the checkout, or run `npm run ui`. It builds the
application, starts the local controller and opens your browser on Windows.
Keep the launcher terminal open while using Grampus. The dashboard works in a
normal browser or Orca's embedded browser.

The developer checkout needs Node 24 or later, Git, `npm ci`, and existing Codex
and Claude subscription logins. It supports Windows 10 or later. This is the
first functional alpha interface, not a packaged installer.

Choose **New task**, enter the existing repository folder and describe the desired
change. The planner receives the complete pinned Git tree of a small UTF-8 text
repository (currently at most 256 KiB and 1024 files). It cannot edit files or run
commands. Consequential questions appear in the discussion. Answer them, or ask
for revisions, until the proposed plan describes the right outcome and examples.
Planning consumes subscription usage only when you explicitly start/send a turn.
Choose a two-, five- or ten-minute time limit per agent turn at kickoff; five
minutes is the default. It applies to planning, implementation and independent
review and is frozen into the proposed task recipe.

Choose **Review for approval** to freeze the proposal as an unapproved guided task.
Review its outcome, criteria, exact file actions, executable/arguments, expected
output, agents, timeouts, pinned base and local delivery message. Approve the plan,
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
Retry starts a fresh attempt and preserves files. No command-line arguments or
assessment JSON files are needed for these steps.

Progress, findings, outputs, retained changes, local commits and a task timeline
are shown alongside the current action. Download the journal-derived Markdown
report for the complete evidence trail. Advanced users can still import a guided
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

Remaining release work includes broader repository context selection, ordinary
project trials, automatic review repair/arbitration, recipe revisions after
approval, accessibility/browser coverage beyond the recorded trials, and clean
distribution validation. No installer, scheduler, automatic push or PR is enabled.
