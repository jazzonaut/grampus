# Grampus

Grampus is a local application being built to coordinate coding agents from task clarification through implementation, independent review, and verified delivery. It aims to reduce human steering and rework while preserving code quality, observability, and control over model usage.

The design targets Windows, macOS, and Linux, with complete operation both with and without Orca.

The [design and decision record](DESIGN.md) captures the requirements agreed during discovery, proposed architecture, and remaining implementation questions.

Current state: the durable controller, live conversations, Git/Orca workspaces and
task-linked sessions with exclusive workspace ownership are implemented.
They include a SQLite journal, versioned task approval, completion gates, Codex and
Claude conversations, structured questions and review findings, interruption,
reconnection, local integration discovery and journaled worktree creation.
Agent-driven repository changes, command/check execution, scheduling, the dashboard and
installers remain to be built.

## Try the first slice

Requires Node.js 24 or newer. From this checkout:

```sh
npm ci
npm test
npm run demo
npm run doctor
npm run doctor -- --orca
```

`demo` runs a **synthetic** task through approval, an interrupted controller,
recovery, retry, review and verification. It prints a journal-based Markdown report
and retains an isolated temporary database. It does not run coding agents or edit
a repository. Simulated evidence cannot complete a real task.

`doctor` checks Git, the Codex app-server handshake and authentication type, and
Claude Code installation and authentication status. `--orca` additionally checks
the current Orca worktree. These checks do not start model inference, validate
subscription entitlements, or establish that agent interruption and resumption work.
Optional executable overrides: `GRAMPUS_CODEX_COMMAND`, `GRAMPUS_CLAUDE_COMMAND`,
and `ORCA_CLI_COMMAND`. Each override is one executable path, not a shell command.

Create and inspect a real brief without starting agent execution:

```sh
npm start -- create examples/brief.json
npm start -- approve <task-id> 1
npm start -- show <task-id>
npm start -- report <task-id>
```

## Live conversations

Use an existing ChatGPT or Claude subscription login. This slice refuses API-key
and third-party provider authentication; it does not enable API billing. Each turn
starts an owned provider process, resumes the recorded conversation if present,
saves the response, and waits for process exit before releasing ownership.

```sh
npm start -- session-new codex
npm start -- session-send <session-id> "Explain the difference between a task and a slice."
npm start -- session-show <session-id>
npm start -- session-list
```

Use `claude` instead of `codex` for Claude. `session-new` accepts `--cwd <directory>`
and `--model <id>`; otherwise it uses the current directory and provider default.
The observed model is saved and used on reconnection. For longer prompts, use
`session-send <id> --prompt-file <path>`.

When a reply has `kind: "question"`, the session enters `awaiting_answer`.
Write a JSON object mapping every question id to a text answer, for example
`{"label":"reef"}`, then run:

```sh
npm start -- session-answer <session-id> answers.json
```

Questions are structured model replies, not native provider permission prompts.
They survive process exits and can be answered later. Review findings contain
severity, description and evidence, but remain agent claims; they do not satisfy
task verification or automatically approve code.

Ctrl+C requests interruption. The controller waits for the owned process to exit;
a successful interrupt request alone is not a stop confirmation. Turns default to
a two-minute timeout (`--timeout-ms`, maximum ten minutes), with **zero automatic
inference retries**. Provider-internal retries may still occur within that deadline.
No prompt is automatically replayed after a failure. An unconfirmed shutdown leaves
the session in `recovery_required`; `session-recover <id>` proceeds only when the
recorded controller and provider PIDs no longer exist on the execution host. It
refuses unknown liveness and does not kill processes. Reused PIDs conservatively
block recovery. Ordinary completed or interrupted turns can be resumed by sending
another message.

The conversations are intended for supplied text. Claude has no general execution
tools; Codex uses a read-only sandbox with shell, integrations and editing approvals
disabled. This is not yet a repository execution or tool-process-tree supervisor.
Live sessions do not create task acceptance evidence or slice commits.

The Claude adapter uses the pinned official Agent SDK and its bundled executable.
`GRAMPUS_CLAUDE_COMMAND` can select a compatible installed executable instead.
`doctor` continues to inspect the installed Claude CLI, which may differ from the
SDK's bundled version. Both adapters verify subscription authentication before
sending a prompt.

Run the repeatable live probes explicitly; they consume subscription usage:

```sh
npm run probe -- codex
npm run probe -- claude
```

Each probe uses a temporary directory and separate controller processes to test
questions, answers, context retention, review findings on a supplied buggy snippet,
interruption and resumption. It prints the retained journal location. The ordinary
test suite does not call either provider or require authentication.

Task commands store data outside the checkout: `%LOCALAPPDATA%/Grampus` on Windows,
`~/Library/Application Support/Grampus` on macOS, or
`${XDG_STATE_HOME:-~/.local/state}/grampus` on Linux. Set `GRAMPUS_HOME` or pass
`--db <path>` to select another location. No cleanup or retention expiry is enabled
yet. Reports contain task content; inspect them before sharing.

## Standalone workspaces

After approving a real task, create its isolated Git worktree from a committed base:

```sh
npm start -- workspace-new <task-id> 1 --repo . --path ../grampus-task --base HEAD
npm start -- workspace-list
npm start -- workspace-show <workspace-id>
npm start -- workspace-inspect <workspace-id>
# Only after failed or interrupted creation:
npm start -- workspace-recover <workspace-id>
```

Use this form for standalone repositories. The destination must not exist, its
parent must exist, and it must be outside existing worktrees and Git metadata.
Grampus pins the base to a commit, creates `grampus/<task-id>`, and locks the worktree
with its workspace id. Dirty and untracked files in the source checkout stay there.
Git's normal checkout configuration, including filters and hooks, still applies.

One reservation per task and destination is recorded in the selected journal before
Git starts. A failed or interrupted creation is never automatically retried or
removed. Recovery confirms process exit and adopts only the registered branch,
ownership lock and clean recorded base. Unknown or live PIDs block recovery;
missing checkouts, mismatched identity and dirty contents require investigation.
`workspace-show` remains usable even if Git inspection fails. Git subprocesses have
a 30-second timeout; this is not supervision of arbitrary hook/filter process trees.

Inspection reports current HEAD, tracked/untracked changes and whether the recorded
task version remains approved. A revised task retains its old workspace but cannot
start a new attempt with that stale version. Rebinding and release/removal are future
work. Workspace readiness does not imply task completion or
permission for an agent to edit files. Local workspace journals contain operational
paths and process identities; keep them out of commits and shared documentation.

## Orca workspaces

For a repository already registered in the running local Orca app:

```sh
npm start -- workspace-new <task-id> 1 --orca --repo . --base main
npm start -- workspace-show <workspace-id>
npm start -- workspace-inspect <workspace-id>
# Only after failed or interrupted creation:
npm start -- workspace-recover <workspace-id>
```

The base ref is explicit and resolved to a commit before creation. Orca chooses the
path and branch, so omit `--path`. Grampus requests an independent worktree with
`--no-parent --setup skip`, without requesting an agent or changing the active view.
Orca may create default terminal tabs according to its settings. Git checkout
filters/hooks still follow repository configuration.

Grampus reserves the task before calling Orca. It records the returned full worktree
id, stable instance identity, path and branch, then checks the actual Git checkout.
It uses Orca CLI operations for creation and identity lookup, with read-only Git
inspection; it does not add a Git lock or mutate Orca metadata behind the app.
CLI capability checks and local identity validation reject unsupported responses.

A CLI timeout does not prove Orca stopped creating the checkout. Creation is never
replayed. If a reply is lost, recovery looks for exactly one worktree with the saved
request name and marker, verifies its pinned base and clean contents, and records
its identity. Missing, ambiguous, incomplete or mismatched results remain blocked.
Once recorded, the instance identity must continue to match even if a checkout is
recreated at the same path. Ordinary display-name/comment changes are allowed after
identity capture. `ready` confirms the checkout, not an agent execution lease or
completion of every Orca background activity. Remote Orca hosts are not supported.

The executable is resolved once per client from `ORCA_CLI_COMMAND`, then `orca-dev`
in a development session, otherwise `orca-ide` on Linux or `orca` elsewhere. There
is no automatic executable fallback, application startup, creation retry or cleanup.

## Task-linked sessions and execution ownership

Prepare a fresh implementation session for an approved workspace and task version:

```sh
npm start -- execution-new <workspace-id> 1 codex
# Use the sessionId returned above:
npm start -- session-send <session-id> "Clarify the implementation steps."
npm start -- execution-show <execution-id>
npm start -- execution-list
# When idle, close the execution and stop its unfinished attempt:
npm start -- execution-close <execution-id>
```

Preparation atomically creates an attempt, a fresh session and their permanent link.
It does not call a model. Each turn receives the approved brief, version, attempt
and role as context. `session-answer` handles pending questions as before. Each turn
claims the workspace before inspecting its current Git/Orca identity and connecting
the provider. No two linked sessions can run there at once in the same journal;
different task workspaces can run independently. Unlinked sessions inside a managed
workspace are refused, and older active sessions also block a new owner.

The lease stays held until provider shutdown is confirmed. An uncertain shutdown or
startup retains it, with no expiry or automatic replay. Use `session-recover` only
after the recorded controller and provider have exited; unknown PIDs remain blocked.
Recovery releases the session and workspace ownership together. A failed/interrupted
implementation attempt needs a new `execution-new` command with a fresh attempt and
session; its old linked session cannot silently resume that settled attempt. Ordinary
unlinked conversations still support explicit resume. `execution-close` never forces
release of an active or uncertain lease.

A successful conversation keeps the implementation attempt open. It does not claim
repository edits, accept evidence or complete a task. Provider tools retain their
current conversation restrictions. Review sessions use `--role review` and require a
successful current artifact supplied through the trusted workflow API; a real CLI
artifact/check runner is still to come. Same-provider review also requires
`--fallback-reason <text>`, and always gets a fresh session. Review replies do not
automatically satisfy review gates. Closed, revised or superseded bindings cannot run.

Ownership applies to participating Grampus sessions sharing one journal. It does not
lock out editors, other journals or agents launched separately through Orca. There is
no shared worker limit, heartbeat takeover or arbitrary tool-process supervision yet.

## Development

```sh
npm run check
npm run build
npm test
```

TypeScript compiles to `dist/`; Node supplies SQLite, process handling and the test
runner. The live Claude adapter adds the official `@anthropic-ai/claude-agent-sdk`
runtime dependency, pinned in the lockfile. Node 24 may emit an experimental SQLite
warning. The SQLite boundary is isolated in `src/store.ts`. Schema 1–4 journals
migrate to schema 5 without losing task, session or workspace data. Older executables cannot reopen a
migrated journal, so retain backups if you need to run an older checkout.

- [Implementation sequence and acceptance examples](docs/IMPLEMENTATION.md)
- [Integration evidence and remaining validation](docs/INTEGRATION-EVIDENCE.md)
- [Architecture and state contracts](docs/ARCHITECTURE.md)
- [Where to resume next session](docs/NEXT-SESSION.md)

The workflow API currently supports one slice per task. It is a trusted controller
boundary, not an API for accepting unvalidated provider messages. Artifact references
and check evidence are supplied by the caller; real workspace hashing and command
execution belong to the next integration slice. Process ownership must be established
before invoking recovery. There is no shared worker scheduler or recovery daemon yet.
