# Grampus

Grampus is a local application being built to coordinate coding agents from task clarification through implementation, independent review, and verified delivery. It aims to reduce human steering and rework while preserving code quality, observability, and control over model usage.

The design targets Windows, macOS, and Linux, with complete operation both with and without Orca.

The [design and decision record](DESIGN.md) captures the requirements agreed during discovery, proposed architecture, and remaining implementation questions.

Current state: the durable controller, live conversations, Git/Orca workspaces and
task-linked sessions with exclusive workspace ownership are implemented. Explicit
repository checks on Windows now produce content-bound validation evidence, with
receipt-based recovery, artifact reviews and exact-output acceptance checks.
An explicit simplification checkpoint and a live standalone greeting pilot now
exercise all gates, with a controller-applied Codex response and Claude review.
Supervised local delivery binds checked content to a commit and supports explicit
recovery without replaying Git writes.
They include a SQLite journal, versioned task approval, completion gates, Codex and
Claude conversations, structured questions and review findings, interruption,
reconnection, local integration discovery and journaled worktree creation.
Agent-driven repository changes, scheduling, the dashboard and
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
disabled. Conversation processes remain separate from the explicit check runner below.
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
successful current artifact from `execution-finish` or the trusted workflow API.
Same-provider review also requires
`--fallback-reason <text>`, and always gets a fresh session. Review replies do not
automatically satisfy review gates through ordinary conversation commands. Use the
explicit artifact review command below. Closed, revised or superseded bindings cannot run.

Ownership applies to participating Grampus sessions sharing one journal. It does not
lock out editors, other journals or agents launched separately through Orca. There is
no shared worker limit or heartbeat takeover. Explicit checks use the same lease.

## Repository checks and implementation submission

The initial check runner requires Windows 10 or later and Windows PowerShell with
`Add-Type` available. It executes a caller-selected command in an implementation
workspace. It does not invoke an agent or interpret repository instructions for you.

```sh
npm start -- execution-snapshot <execution-id>
# Read the returned instructions and diff; prepare a check specification outside the workspace.
npm start -- execution-check <execution-id> <check.json>
npm start -- check-show <check-id>
# Explicitly submit implementation once the latest check passes:
npm start -- execution-finish <execution-id> <check-id>
```

The check JSON has exactly these fields:

```json
{
  "name": "Greeting regression check",
  "file": "<absolute path to node.exe>",
  "args": ["--test", "test/greeting.test.js"],
  "timeoutMs": 120000,
  "artifact": "<sha256:... from execution-snapshot>",
  "instructionsDigest": "<digest from execution-snapshot>"
}
```

Choose a command that follows the repository rules and approved plan. `file` must
name an existing absolute executable; arguments are passed literally, without an
implicit shell. Scripts need their interpreter. The command inherits the local
environment and runs at the workspace root. Keep the specification outside the
workspace so editing it does not invalidate its own artifact digest. This is a trusted
local command interface, not a provider tool approval policy or a sandbox.

Snapshots include HEAD, the index, baseline/tracked/nonignored untracked file hashes,
and structured changes with old/new bytes (text or base64). Root and Git-visible
nested `AGENTS.md`/`CLAUDE.md`, plus inherited ancestor copies, are shown and hashed.
Copying the instruction digest acknowledges that snapshot; it does not establish
semantic compliance. Other rule/skill formats still require caller interpretation.
Ignored build outputs/dependencies, external services and environment values are not
part of the digest. Symlinks, submodules and unresolved indexes are currently refused.

Each check journals intent and claims the workspace before dispatch. Windows Job
Objects supervise ordinary descendants. A timeout, interruption, nonzero exit, leftover
child process, changed repository input or unknown shutdown cannot pass. The journal
retains up to 64 KiB per output stream and flags truncation; output exceeding a monitored
2 MiB combined threshold stops the job. These are diagnostics, not an output oracle.

`execution-finish` rechecks the current content and accepts only the latest passing
check from that execution. It marks implementation successful and records validation;
simplification, independent review and acceptance verification remain separate gates.
Failed/interrupted checks keep the implementation open for an explicit correction and
new check. Commands are never replayed automatically.

A lost controller/supervisor retains the durable lease until explicit recovery.
Normal descendants are covered, but work delegated to an existing
service, WMI, a scheduler or an external agent is outside the job. macOS/Linux command
supervision and provider-driven repository editing remain outstanding.

## Recover an interrupted operation

```sh
npm start -- check-show <check-id>
npm start -- check-recover <check-id>
# For a snapshot, submission, simplification or completion interrupted before its transaction committed:
npm start -- execution-recover <execution-id>
```

Recovery requires the previous controller to be absent on the same host. A dispatched
check additionally requires a matching supervisor receipt proving the tool job settled,
and an absent supervisor. The receipt is flushed before replying to the controller.
The hidden supervisor host survives a controller crash long enough to stop its job
and write the receipt. Dead process ids alone cannot release a dispatched check.

Recovery records the check as interrupted, preserves available output, and never
replays the command or accepts a lost success. Run a fresh check explicitly. A recorded
pre-dispatch boundary can recover without a receipt; read-only operations use their
separate protocol. Old journals lacking these proofs, missing/invalid receipts and
live or unverifiable owners remain blocked. Conversation recovery cannot release a
command lease. Receipt/output directories are retained beside the journal as
`<database>.checks/`; keep them with the journal and out of commits. They contain local
operational data and are trusted like the journal, not a sandbox against its owner.

## Review and verify a submitted artifact

After submission, explicitly assess names, duplication, unnecessary complexity and
whether the checks exercise useful behavior. Record that assessment with:

```sh
npm start -- execution-simplify <implementation-execution-id> simplification.json
```

```json
{
  "artifact": "<submitted sha256:...>",
  "instructionsDigest": "<digest from execution-snapshot>",
  "outcome": "passed",
  "summary": "Describe what you inspected and why further simplification is unnecessary."
}
```

The outcome can be `passed`, `failed` or `skipped`; the latter two keep completion
blocked and return a nonzero CLI status. This is a trusted caller's assessment.
Grampus verifies its artifact binding, not the judgment in the prose. A new valid
assessment request makes the gate pending before inspecting content; stale inputs
or a controller crash cannot restore an older pass. Read-only recovery releases a
crashed assessment without accepting it. Changes made while simplifying require
a fresh implementation attempt and validation before assessment of the new artifact.

```sh
npm start -- execution-new <workspace-id> 1 claude --role review
npm start -- execution-review <review-execution-id>
# If the reviewer asks questions, supply the same question-id JSON format as session-answer:
npm start -- execution-review <review-execution-id> --answers-file answers.json
npm start -- execution-verify <implementation-execution-id> acceptance.json
npm start -- execution-complete <implementation-execution-id>
```

Artifact review uses a fresh independent session, verifies the submitted digest,
supplies the repository text, instructions and diff, and verifies content again after
provider shutdown. This initial mode supports at most 256 KiB of UTF-8 repository text;
binary files and larger repositories need a future review-context strategy. Blocking
findings fail the review gate. Questions, interruptions and non-review replies leave
it pending. Ordinary `session-send` replies still cannot pass gates. The provider's
repository tools remain disabled; this reviews supplied content, not runtime behavior.

Acceptance JSON uses the check fields above plus the exact approved `criteria` list
and an `expectedStdout` string, for example:

```json
{
  "name": "Greeting acceptance",
  "file": "<absolute path to node.exe>",
  "args": ["greeting.js"],
  "timeoutMs": 120000,
  "artifact": "<submitted sha256:...>",
  "instructionsDigest": "<digest from execution-snapshot>",
  "criteria": ["Print hello"],
  "expectedStdout": "hello\n"
}
```

Verification requires exit zero, unchanged submitted content and an exact match to
the expected decoded stdout, without truncated or unavailable output. The caller must choose a
meaningful command, expectation and criterion mapping; the controller checks the
observations, not the semantic sufficiency of that plan. Failed/skipped results remain
visible. Starting a new review or acceptance check makes the corresponding gate pending,
so a lost or failed newer run cannot leave an older pass current.

Completion verifies the artifact again and requires every existing gate and decision.
These commands do not invent simplification assessments, commit code or push task branches.

## Deliver a checked artifact locally

Once every gate passes, use delivery instead of `execution-complete` to make a local
commit and complete the task together. This initial path requires Windows and a
standalone Git implementation execution; Orca delivery is not enabled.

```sh
npm start -- execution-deliver <implementation-execution-id> delivery.json
npm start -- delivery-show <delivery-id>
# After an interrupted controller has exited:
npm start -- delivery-recover <delivery-id>
```

```json
{
  "artifact": "<submitted sha256:...>",
  "instructionsDigest": "<digest from execution-snapshot>",
  "message": "Implement the approved change",
  "timeoutMs": 120000
}
```

Keep the specification and journal outside the task worktree. Delivery claims its
workspace, rechecks all gates and the snapshot, and journals intent before dispatch.
The supervised worker stages the whole checked worktree, verifies every staged
path, raw blob and mode, then runs Git commit using the repository's configured
identity, hooks and signing settings. A unique `Grampus-Delivery` marker is added to
the commit message. No push is requested. Empty commits are not created.

The controller verifies the resulting commit's parent, marker/message, complete tree,
index, working files and instructions. Only a matching result with confirmed successful
process exit records delivery and task completion in one database transaction.
The delivery record connects the original checked digest to the final commit even
though staging and HEAD change the snapshot digest.

Git normalization or clean filters that change checked bytes are rejected before
commit. Hook changes may be detected after a commit already exists. Failures retain
the index, files and any commit for investigation; Grampus does not reset, amend,
delete Git lock files or rerun delivery. Changes that invalidate the artifact require
a new implementation attempt and repeated gates. Git hooks retain their normal
effects; work delegated to external services is outside process supervision.

An uncertain exit retains ownership. Explicit recovery requires an absent controller
on the same host and, after dispatch, a matching supervisor receipt proving process
settlement. A successful receipt permits inspection and acceptance of the exact
existing commit. An interrupted/failed command is not accepted even if a commit
exists. Missing proof stays blocked. A proven pre-dispatch crash releases ownership
without running Git. Recovery never replays staging or commit.

## Live standalone task pilot

```sh
npm run build
npm run probe:task -- --live
```

This opt-in Windows probe uses both subscriptions. It creates an isolated greeting
repository under ignored `.grampus/task-probes/`, copies your configured Git identity
into that fixture, and approves a fixed one-line task. Codex supplies the replacement;
the controller applies it only if it matches the one permitted output statement.
It records an explicit simplification assessment, runs real checks, requests a fresh
Claude artifact review, verifies exact stdout, then uses supervised delivery to make
and verify a local fixture commit before completing the task and saving a journal-derived
report. No fixture branch is pushed.

Failures retain evidence for investigation and do not trigger inference retries.
The pilot retains local journals, reports and worktrees, which can contain operational
paths; keep them out of commits. It demonstrates a bounded controller-applied change
and verified delivery. Native agent editing and the full Orca workflow remain work.
Delivery crash recovery is tested separately with real Git and offline gate fixtures.

## Development

```sh
npm run check
npm run build
npm test
```

TypeScript compiles to `dist/`; Node supplies SQLite, process handling and the test
runner. The live Claude adapter adds the official `@anthropic-ai/claude-agent-sdk`
runtime dependency, pinned in the lockfile. Node 24 may emit an experimental SQLite
warning. The SQLite boundary is isolated in `src/store.ts`. Schema 1–7 journals
migrate to schema 8 without losing task, session or workspace data. Older executables cannot reopen a
migrated journal, so retain backups if you need to run an older checkout.

- [Implementation sequence and acceptance examples](docs/IMPLEMENTATION.md)
- [Integration evidence and remaining validation](docs/INTEGRATION-EVIDENCE.md)
- [Architecture and state contracts](docs/ARCHITECTURE.md)
- [Where to resume next session](docs/NEXT-SESSION.md)

The workflow API currently supports one slice per task. It is a trusted controller
boundary, not an API for accepting unvalidated provider messages. Its direct evidence
methods still trust the caller; the check CLI adds verified repository hashing and
command evidence. Check selection and coverage remain caller responsibilities.
Process ownership must be established
before invoking recovery. There is no shared worker scheduler or recovery daemon yet.
