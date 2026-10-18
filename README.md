# Grampus

Grampus is a local application being built to coordinate coding agents from task clarification through implementation, independent review, and verified delivery. It aims to reduce human steering and rework while preserving code quality, observability, and control over model usage.

The design targets Windows, macOS, and Linux, with complete operation both with and without Orca.

The [design and decision record](DESIGN.md) captures the requirements agreed during discovery, proposed architecture, and remaining implementation questions.

The immediate release target is a [small Windows alpha](docs/RELEASE.md), with
dependable recovery and one guided task workflow before broader platform support.

Current state: the durable controller, live conversations, Git/Orca workspaces and
task-linked sessions with exclusive workspace ownership are implemented. Explicit
repository checks on Windows now produce content-bound validation evidence, with
receipt-based recovery, artifact reviews and exact-output acceptance checks.
An explicit simplification checkpoint and a live standalone greeting pilot now
exercise all gates, with a controller-applied Codex response and Claude review.
A two-file library/CLI pilot also reaches verified delivery after a manual
simplification checkpoint and independent review.
Supervised local delivery binds checked content to a commit and supports explicit
recovery without replaying Git writes.
Approved briefs can include ordered slices. Each slice needs fresh evidence and
supervised delivery; the final slice verifies every task criterion.
A guided Windows CLI now connects those gates with whole-plan approval, exact
file authorization, explicit simplification, questions, stop/retry controls and
restart reconciliation. The CLI supports authored JSON briefs.
The local browser dashboard adds plain-language kickoff and clarification,
reviewable generated plans, task controls and retained evidence without CLI arguments.
They include a SQLite journal, versioned task approval, completion gates, Codex and
Claude conversations, structured questions and review findings, interruption,
reconnection, local integration discovery and journaled worktree creation.
Supervised Claude and Codex file editing, creation and deletion is available for explicitly named text files
in standalone and local Orca Windows workspaces. A per-user Windows snapshot
installer now separates installed use from development, with explicit updates.
Broader tools, scheduling and published release distribution remain to be built.

## Install Grampus

Double-click **Install-Grampus.cmd**, or run `npm run install:local` from this
checkout. The interactive Windows installer checks required tools, builds an
independent snapshot outside the repo and adds `grampus` to your user PATH.
Open a new terminal and run `grampus` to open the dashboard, `grampus --version`
to identify the installed build, or `grampus update` to install a fresh snapshot
from the recorded checkout. See [installation and updates](docs/INSTALLATION.md).

Installed task data and port 4317 are separate from development data and port 4318.
You can keep improving this checkout while trying the installed app; source edits
take effect in the installation only after an explicit update.

## Run from the checkout

After `npm ci`, double-click **Grampus-Dev.cmd** or run:

```sh
npm run ui
```

The local dashboard opens in your browser. Choose **New task**, enter an
existing repository and describe the desired change. Discussion, plan approval,
file authorization, simplification, questions, progress, recovery and reports are
available in the interface. See [the dashboard walkthrough](docs/DASHBOARD.md).
This local distribution supports Windows with autonomous repository exploration
for planning, implementation and review. File hints are optional; exact file changes
still require approval. Large repositories and unchanged binary assets are supported. See
[repository context and scale](docs/REPOSITORY-CONTEXT.md). Ordinary-project trials
and release-wide distribution validation remain release work.

## CLI and integration tools

For the guided Windows workflow, start with
[the guided task walkthrough](docs/GUIDED-WORKFLOW.md). It connects the existing
gates with task-level commands, explicit file authorization and simplification
checkpoints, next-action guidance and restart reconciliation.

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

## Sequential slices

[examples/multislice-brief.json](examples/multislice-brief.json) shows an optional
`slices` array. Each entry has `title`, `plan` and a nonempty `criteria` list naming
exact task criteria. Plans allow 1–64 slices; their criteria must collectively cover
the whole task. Approval names the version of the complete ordered plan.
Briefs without `slices` retain the original one-slice behavior.

Use the existing execution, check, simplification, review, verification and delivery
commands for each slice. Intermediate acceptance checks map exactly to that slice's
criteria. The final slice maps to **every task criterion**, including earlier slices,
and its independent review must inspect integration. Reviewers receive the full brief,
current slice and earlier delivery references, alongside the existing repository context.

```sh
npm start -- create examples/multislice-brief.json
npm start -- approve <task-id> 1
# Create a workspace and run the first slice through its gates.
npm start -- execution-deliver <first-implementation-id> first-delivery.json
npm start -- show <task-id>
# Delivery readies the next slice. Explicitly create its fresh implementation session:
npm start -- execution-new <same-workspace-id> 1 codex
# Run fresh gates, final integration review and whole-task acceptance, then:
npm start -- execution-deliver <final-implementation-id> final-delivery.json
```

Delivery atomically records the slice outcome and readies the next slice, clearing
the current attempt and evidence. It completes the task only after the final slice.
Each slice normally creates a separate verified commit; explicit `mode: "no_change"`
can record an already satisfied outcome with unchanged HEAD. `execution-complete`
cannot bypass delivery for a brief with planned slices. Retry attempts stay on the
current slice, and previous sessions cannot write or supply evidence for a later one.

Continuation uses the same workspace, requirement version, approval and original
base commit. Before the next slice starts, raw HEAD/index/files must match the last
delivered HEAD and inherited instructions must be unchanged. Changed state is refused
for inspection. Receipt recovery advances only the verified delivered slice, once,
without repeating Git writes or starting provider work. A failed delivery preserves
the current slice and repository state. No automatic slice scheduler is provided.

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
a successful interrupt request alone is not a stop confirmation. Agent turns have
no automatic deadline. Low-level CLI calls can explicitly opt into `--timeout-ms`
(maximum ten minutes; `0` disables it), with **zero automatic inference retries**.
Guided agents also ignore legacy saved deadlines; validation and acceptance commands
retain their approved time limits. Provider-internal retries may still occur.
No prompt is automatically replayed after a failure. An unconfirmed shutdown leaves
the session in `recovery_required`; `session-recover <id>` proceeds only when the
recorded controller and provider PIDs no longer exist on the execution host. It
refuses unknown liveness and does not kill processes. Reused PIDs conservatively
block recovery. Ordinary completed or interrupted turns can be resumed by sending
another message.

Conversations can use supplied text, approved repository/reference read tools and
configured MCP integrations, including referenced Linear tickets. Claude has no
general execution tools; Codex uses a read-only sandbox with shell and editing
approvals disabled. Conversation processes remain separate from the explicit check runner below.
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

Task commands store data outside the checkout, under `%LOCALAPPDATA%/Grampus` on Windows,
`~/Library/Application Support/Grampus` on macOS, or
`${XDG_STATE_HOME:-~/.local/state}/grampus` on Linux. Installed copies use the `installed`
subdirectory; development uses `development/<checkout-id>`. Earlier journals in the
root directory are preserved and can be opened explicitly with `--db`.
Set `GRAMPUS_HOME` or pass
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
Standalone checkout disables automatic CRLF conversion for its single Git command
so the pinned blob bytes stay comparable. Explicit checkout attributes, filters and
hooks still apply; no Git configuration is changed.

One reservation per task and destination is recorded in the selected journal before
Git starts. A failed or interrupted creation is never automatically retried or
removed. Recovery confirms process exit and adopts only the registered branch,
ownership lock and clean recorded base. Unknown or live PIDs block recovery;
missing checkouts, mismatched identity and dirty contents require investigation.
`workspace-show` remains usable even if Git inspection fails. Worktree creation has
a five-minute Git timeout; routine inspection retains 30 seconds. This does not
supervise arbitrary hook/filter process trees.

Inspection reports current HEAD, tracked/untracked changes and whether the recorded
task version remains approved. A low-level brief revision cannot start a new attempt
with a stale workspace version. Guided `task-revise` updates recipe/version metadata
together, preserving files and delivered slices while requiring fresh approval.
`task-release-workspace` can release a proved-unused failed standalone reservation;
it never deletes files or branches. General worktree removal remains future work.
See [guided workflow](docs/GUIDED-WORKFLOW.md). Workspace readiness does not imply task completion or
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
It uses Orca CLI operations for creation and identity lookup; it does not add a Git
lock or mutate Orca metadata behind the app. Native editing, checks and local commit
delivery use Grampus-owned supervised processes inside the verified checkout. Orca
does not independently launch or schedule those agents. Git staging and committing
are ordinary repository operations; worktree lifecycle remains under Orca's control.
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
current conversation restrictions. Native editing uses the separate command below.
Review sessions use `--role review` and require a
successful current artifact from `execution-finish` or the trusted workflow API.
Same-provider review also requires
`--fallback-reason <text>`, and always gets a fresh session. Review replies do not
automatically satisfy review gates through ordinary conversation commands. Use the
explicit artifact review command below. Closed, revised or superseded bindings cannot run.

Ownership applies to participating Grampus sessions sharing one journal. It does not
lock out editors, other journals or agents launched separately through Orca. There is
no shared worker limit or heartbeat takeover. Explicit checks use the same lease.

## Native file implementation

Prepare a fresh Claude or Codex implementation execution, inspect its snapshot and read the
discovered repository instructions. Then supply an explicit per-turn policy:

```sh
npm start -- execution-new <workspace-id> 1 claude
npm start -- execution-snapshot <implementation-execution-id>
npm start -- execution-implement <implementation-execution-id> edit-policy.json
npm start -- implementation-show <implementation-run-id>
```

```json
{
  "artifact": "<current sha256:...>",
  "instructionsDigest": "<digest from execution-snapshot>",
  "files": ["src/greeting.js"],
  "create": ["src/format.js"],
  "delete": ["src/obsolete.js"]
}
```

Use `codex` instead of `claude` to select Codex. Both providers support standalone Git
and local Orca workspaces on Windows. Orca identity is checked before dispatch, again
inside the worker and after process settlement; replaced or archived instances fail.
The policy names 1–64 distinct relative text-file paths across `files`, optional
`create` and optional `delete`; each file is limited to 256 KiB. `files` names existing files. `create`
names paths absent from both the snapshot and filesystem, with existing parent
directories. Ignored paths are rejected so created files remain visible to checks
and review. `delete` names existing snapshot files that may only be removed, with
their bytes checked against that snapshot before authorization. Deletion paths
cannot also appear in `files` or `create`, be edited, or be recreated. A policy
with only creations/deletions uses `"files": []`. Omit optional lists for existing-file
policies; their behavior is unchanged. Authorization permits an action; task
acceptance checks must still prove a required addition or removal occurred.
Claude may read snapshot-visible text files and use native `Edit`/`Write` on authorized
paths, creating new files with `Write` before reading or editing them. Directory
creation/removal, binary files, links, Git metadata and repository instruction
or provider-configuration files are outside this initial mode. Repository instructions
are supplied in the prompt, with their digest verified before provider connection.

Claude file-tool requests are checked by an SDK hook and their decisions journaled
before permission is granted. When a nonempty `delete` list is supplied, Claude
also receives `mcp__grampus_files__delete_file`, a controller-owned tool running
inside the supervised worker. Its handler rechecks active-turn ownership, exact
path scope, links and unchanged bytes, journals authorization before unlinking,
and records successful removal. It cannot delete directories or run commands.
Codex receives the approved file contents in its prompt
(at most 768 KiB of encoded context) and uses native `apply_patch`. Grampus checks every
proposed patch against the active thread, turn and approved paths before granting a
single-use approval. Additions require an exact `create` path which is still absent;
later updates to that created file are allowed. Deletions require an exact `delete`
path with unchanged snapshot bytes. Moves, root/session grants and stale or
repeated requests are denied. Codex must confirm read-only sandbox mode and approval
routing to the controller before a turn starts.

Native shell, delegation and web tools are not exposed. Configured MCP tools remain
available for task context; external actions require explicit task authorization.
Source-project connections carry into isolated workspaces without enabling servers
the user disabled. The dashboard reports provider connection status. The local deletion
tool is absent when no deletion paths are supplied. The Claude SDK's
internal `StructuredOutput` tool is permitted only for a validated final reply. Ordinary
conversations and reviewers retain their tool restrictions. Editing sessions cannot be
resumed through `session-send`; keep using `execution-implement` with a fresh snapshot
policy. For pending questions, add `--answers-file answers.json`. Optional
`--prompt-file` and `--timeout-ms` flags provide task steering and a bounded deadline.

The provider runs inside the Windows supervised process tree. After confirmed exit,
Grampus records before/after snapshots and checks that only authorized file contents
and explicitly named additions/removals changed. Successful replies leave implementation running, with no gates passed: run
checks, submit, assess simplification, obtain independent review, verify acceptance and
deliver separately. Failed/interrupted edits are retained and need a fresh execution
attempt. There is no automatic rollback or inference replay.

```sh
# After the previous controller has exited:
npm start -- implementation-recover <implementation-run-id>
```

Recovery requires a matching supervisor receipt after dispatch; dead provider PIDs
alone are insufficient. It records interruption, preserves partial edits and releases
ownership only after settled process proof. A pre-dispatch crash can recover without
a receipt. Missing proof stays blocked. The policy controls provider tools rather
than providing an OS filesystem sandbox; external editors can still race file checks.
Provider session caches and local journals remain private operational data.

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
Objects supervise ordinary descendants. After root exit, a cancellable settlement
window of at most 100 ms waits for the job count to reach zero, within the original
tool deadline. A timeout, interruption, nonzero exit, child process remaining beyond
that window, changed repository input or unknown shutdown cannot pass. The journal
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
supervision and provider shell execution remain outstanding. Native file editing
uses its own supervised path above.

## Recover an interrupted operation

```sh
npm start -- check-show <check-id>
npm start -- check-recover <check-id>
# For a snapshot, submission, simplification or completion interrupted before its transaction committed:
npm start -- execution-recover <execution-id>
```

Recovery requires the previous controller to have exited on the same host. A dispatched
check additionally requires a matching supervisor receipt proving the tool job settled,
and an exited supervisor. New Windows leases and receipts record exact process
creation times, allowing recovery to distinguish a recycled process id from the
original owner. Live owners and unknown identities still block recovery; older
records without creation times require the process id to be absent.
The receipt is flushed before replying to the controller.
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
provider shutdown. New guided tasks supply approved supporting text plus every
changed file and repository instruction, with explicit omission records. Text
context is bounded to 512 KiB and 256 files; individual text files remain limited
to 256 KiB. Unselected binary assets are still hashed. See
[repository context and scale](docs/REPOSITORY-CONTEXT.md). Blocking
findings fail the review gate. Questions, interruptions and non-review replies leave
it pending. Ordinary `session-send` replies still cannot pass gates. The provider's
repository tools remain disabled; this reviews supplied content, not runtime behavior.

Acceptance JSON uses the check fields above plus the exact current slice `criteria` list
(every task criterion for the final slice, or for a brief without planned slices)
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
commit and complete the task together. This path requires a standalone Git or local
Orca implementation execution on Windows.

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

If the approved behavior already exists, add `"mode": "no_change"` to the delivery
JSON and use `message` to explain why no change is needed. Every gate still must
pass. This mode verifies the raw HEAD tree, index, working files and instructions
without staging or invoking commit hooks. Success records `outcome: "no_change"`,
`commit: null` and the unchanged HEAD in the saved request. The default `"commit"`
mode still requires a real commit; an empty diff does not imply successful delivery.
No-change delivery uses the same supervised receipt and explicit recovery commands.

The controller verifies the resulting commit's parent, marker/message, complete tree,
index, working files and instructions. Only a matching result with confirmed successful
process exit records delivery and task completion in one database transaction.
The delivery record connects the original checked digest to the final commit even
though staging and HEAD change the snapshot digest.

For Orca, the durable request also binds the execution, workspace and stable instance
identity. The worker checks that binding and its lease, and asks Orca to verify the
instance before staging and before committing. Final verification and recovery check
the original Orca identity again. A replaced, archived or unavailable workspace cannot
be accepted; files and any unaccepted commit remain available for investigation.
No Orca terminal, agent-launch, metadata-edit or worktree-lifecycle mutation is sent
during editing or delivery. Grampus supervises the processes it starts; separately
launched Orca agents and external editors are outside that ownership.

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

For no-change recovery, a successful receipt instead permits read-only verification
of the original HEAD, index, files and instructions. Changed state prevents completion.

## Live task pilot

```sh
npm run build
npm run probe:task -- --live
# Claude native editing followed by independent Codex review:
npm run probe:task -- --live --native
# Codex native editing followed by independent Claude review:
npm run probe:task -- --live --native-codex
# Repeat with a local Orca-created worktree:
npm run probe:task -- --live --native-codex --orca
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
and verified delivery. `--native` instead lets Claude edit the greeting through its
authorized file tools and uses Codex as reviewer. `--native-codex` uses approved Codex
patches and Claude review. Both native variants leave source editing to the provider.
`--orca` registers the isolated fixture repository with the running local Orca app
and creates its worktree through Orca. It retains the fixture and reports the stable
workspace identity; remove a finished probe worktree through Orca, never raw Git.
Orca's repository registration and local evidence remain for inspection. Remote-host
overrides are refused by this probe. It exercises Grampus-owned provider processes
in an Orca workspace, not Orca's agent-launch or terminal-coordination APIs.
Delivery crash recovery is tested separately with real Git and offline gate fixtures.

## Development

### Multi-file live pilot

The Windows pilot below asks a provider to implement a numeric summary
library and JSON CLI in two existing files by default. Its independent oracle checks empty,
negative and decimal inputs, input preservation, invalid values, argument handling,
exit codes and exact output. It consumes subscription usage.

```sh
npm run build
npm run probe:multifile -- --live
# Or select Claude implementation and Codex review:
npm run probe:multifile -- --live --provider claude
# Use a local Orca-created workspace:
npm run probe:multifile -- --live --orca
# Start without the library and authorize its exact creation path:
npm run probe:multifile -- --live --create-library
# Also require removal of an obsolete tracked file:
npm run probe:multifile -- --live --create-library --delete-obsolete --provider claude
```

After native editing and regression validation, the command stops at a durable
checkpoint and prints the workspace, execution id, journal, validation id and assessment path.
Inspect both generated files and the saved oracle using
`npm start -- --db <journal.sqlite> check-show <validation-id>`, then edit the generated
assessment JSON with an explicit outcome and a concrete simplification summary.
Its initial `skipped` outcome does not pass a gate. Continue with:

```sh
npm run probe:multifile -- --live --finish <execution-id> --db <journal.sqlite> --assessment <assessment.json>
```

Continuation validates the assessment against the submitted artifact, obtains a
fresh other-provider review, repeats the saved oracle for acceptance, and makes a
verified local fixture commit. The original validation command and expected output
are retained at the checkpoint. A failed/skipped assessment is journaled and stops
before review. Once review/delivery continuation is requested, it cannot be replayed
by this helper; inspect or recover interrupted operations through the ordinary CLI.
Questions or blocking findings also require explicit handling. No inference retry
or Git reset is performed. Reports and journals stay under ignored
`.grampus/task-probes/`. Orca mode registers the isolated fixture repository and
creates its checkout through the supported CLI, preserving the same native tool
policies, stable instance checks and supervised delivery. Omit `--orca` on finish;
continuation uses the recorded workspace. Remote Orca overrides are refused.

For the same task delivered as two approved slices:

```sh
npm run probe:multifile -- --live --slices
# Inspect summary.cjs and the library oracle, then assess and deliver slice one:
npm run probe:multifile -- --live --finish <first-execution-id> --db <journal.sqlite> --assessment <assessment-slice-1.json>
# Only after verified delivery, explicitly start the CLI slice:
npm run probe:multifile -- --live --next <task-id> --db <journal.sqlite>
# Inspect the CLI, delivered library and complete oracle, then assess and deliver:
npm run probe:multifile -- --live --finish <second-execution-id> --db <journal.sqlite> --assessment <assessment-slice-2.json>
```

`--slices` also accepts `--provider claude` and `--orca` at startup. It cannot
combine with creation, deletion or fault injection modes. The first slice writes
only summary.cjs and checks the library contract, preserving the unfinished CLI.
The second uses a fresh session of the original provider/model and writes only
cli.cjs, preserving the delivered library. Final independent review and acceptance
cover the whole task. Each slice retains its own assessment and result file;
`result.json` and the report show the latest checkpoint.

`--next` requires this helper's original approved brief and a verified first-slice
delivery. It journals intent before creating the next execution and cannot be
replayed after an uncertain start. Finish continuation is likewise recorded per
execution before review. Use ordinary CLI inspection/recovery after interruption;
neither command retries provider inference or repeats a delivery. Failed/skipped
simplification assessments never authorize review or the next slice.

Exercise a real controller crash after the first file changes:

```sh
npm run probe:multifile -- --live --provider claude --interrupt-after-edit
npm run probe:multifile -- --live --provider claude --interrupt-after-edit --orca
# Interrupt just after an authorized deletion, before implementation finishes:
npm run probe:multifile -- --live --provider claude --delete-obsolete --interrupt-after-edit
```

This mode requests separate file edits, observes a real library change, and kills
only the controller process it launched. It waits for a matching terminal supervisor
receipt and absent supervisor, then runs `implementation-recover` in a new CLI
process. It verifies that the library edit survived, the CLI stayed unfinished,
recovery preserved all fixture files, ownership was released, HEAD stayed unchanged
and no provider activity or completion evidence was added. The task remains stopped;
an explicit fresh execution is needed to continue. A provider that finishes too
quickly or edits both files together fails this probe rather than claiming a crash
was demonstrated. No automatic retry is performed.

With `--delete-obsolete`, the observer requests deletion first and waits for that
actual removal instead of a library edit. It verifies the file stays absent through
recovery and both implementation files remain unfinished. This also combines with
`--create-library`, preserving the initially absent library without creating it during recovery.

Evidence is saved as `recovery.json` and a journal-derived report. Interrupted files
and Orca fixture workspaces are retained for inspection; use Orca for any later
removal of an Orca-owned workspace.

### Build and test

```sh
npm run check
npm run build
npm test
```

TypeScript compiles to `dist/`; Node supplies SQLite, process handling and the test
runner. The live Claude adapter adds the official `@anthropic-ai/claude-agent-sdk`
runtime dependency and Zod for its in-process deletion-tool schema, both pinned in
the lockfile. Node 24 may emit an experimental SQLite
warning. The SQLite boundary is isolated in `src/store.ts`. Schema 1–9 journals
migrate to schema 10 without losing task, session or workspace data. Older executables cannot reopen a
migrated journal, so retain backups if you need to run an older checkout.

- [Implementation sequence and acceptance examples](docs/IMPLEMENTATION.md)
- [Integration evidence and remaining validation](docs/INTEGRATION-EVIDENCE.md)
- [Architecture and state contracts](docs/ARCHITECTURE.md)
- [Where to resume next session](docs/NEXT-SESSION.md)

The workflow API supports explicit sequential slices. It is a trusted controller
boundary, not an API for accepting unvalidated provider messages. Its direct evidence
methods still trust the caller; the check CLI adds verified repository hashing and
command evidence. Check selection and coverage remain caller responsibilities.
Process ownership must be established
before invoking recovery. There is no shared worker scheduler or recovery daemon yet.
