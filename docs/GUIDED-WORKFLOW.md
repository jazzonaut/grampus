# Guided Windows task workflow

New plans use the [automatic local workflow](WORKFLOW.md): approval authorizes the
listed files and commands, routine validation/acceptance failures get bounded repairs,
and independent review includes an explicit simplification assessment. Set
`workflowPolicy.mode` to `supervised` for the manual walkthrough below. Older saved
plans retain supervised behavior; `task-automate <id>` explicitly enables automatic
continuation within an existing approved plan.

Exact file scope supports regular UTF-8 files up to 1 MiB each and 4 MiB of existing
text per slice. Individual edit/patch text remains bounded to 256 KiB. Large editable
files are read through repository exploration; they are not excluded by filename.
Gitignored untracked output stays outside the inventory, while tracked lockfiles
and generated sources remain covered. Unsupported pinned file sizes fail during
planning, before approval and workspace creation. Runtime scope errors identify the
path and reason; revise an unsupported scope before retrying.

The guided CLI connects the existing task controller into a repeatable workflow.
It prepares workspaces and sessions, runs native implementation and validation,
pauses for explicit simplification, then runs independent review, acceptance and
verified local delivery. It prints the next command at each checkpoint.

For plain-language kickoff and on-screen controls, use the
[local dashboard](DASHBOARD.md). This document describes the authored-plan CLI.
This is an early Windows interface with bounded text context inside larger repositories.
See [repository context and scale](REPOSITORY-CONTEXT.md) for selection and limits.
Approved review policies can prepare bounded repairs and a fresh arbitration.
Author and resolve ambiguities in the brief before approving it. Checks and expected
output must demonstrate the intended behavior; Grampus cannot establish their
semantic sufficiency merely from their exit code.

## Prepare a task

Build with `npm run build`. Copy [examples/guided-task.json](../examples/guided-task.json)
and adapt it to a small existing repository with a committed baseline. The example
expects an existing `greeting.js`. Repository and destination paths are relative to
the plan file. The destination must be absent and its parent must already exist.

The plan contains a `brief`, `workspace`, optional agent selections and one execution
configuration per slice. Commands use separate executable/argument fields, without
shell expansion. `file: "node"` resolves to the current Node executable when the
plan is stored; other executables need absolute paths. Relative script arguments
are interpreted inside the task worktree. Timeouts default to 120000 ms.

```sh
npm start -- task-new my-task.json
```

This stores a draft without creating a worktree or calling either provider. It
resolves the repository and pins the base ref to a commit. The displayed approval
digest covers the brief, all file scopes, commands, expected output, providers,
models, selected context and delivery messages. Inspect that complete plan, then copy its displayed
command, which has this form:

```sh
npm start -- task-approve <task-id> 1 <displayed-plan-digest>
npm start -- task-run <task-id>
```

Ordinary `approve` alone does not approve a guided execution recipe. Changes to
the underlying brief/version invalidate guided continuation. Use the guided revision
command below to update the recipe and workspace version together.

The default implementer is Codex and the reviewer is Claude. Select Claude
implementation to default to Codex review. The guided path requires different
providers; it never chooses a same-provider fallback implicitly. Existing first-party
subscription authentication remains required. Transport failures never retry inference
automatically, and no branch is pushed.

## Prepare repository prerequisites

The planner infers setup from the pinned repository's manifests, lockfiles, workspace
configuration and documentation. Fresh Git and Orca worktrees have no ignored
dependencies or caches. An optional top-level `preparation` command uses the same
`name`, `file`, `args` and `timeoutMs` fields as validation. It runs before file
authorization in every attempt and again after implementation, before validation.
Use a repeatable restore that leaves Git-visible inputs unchanged. For example,
a pnpm repository can use its workspace's frozen-lockfile installation. Other
toolchains use their own repository-specific restore commands; the controller
does not detect or install a particular package manager itself.

A slice may supply its own `preparation` command to replace the second run. This
step can update only the slice's authorized paths, such as a lockfile when the
implementer changes a manifest. Include each generated path in the slice scope;
the implementer cannot run commands and should leave generation to this command.
Git state and repository instructions must remain unchanged. No-change slices
allow no Git-visible writes. Untracked ignored dependencies and caches remain
outside repository snapshots, as they do for other supervised operations.

Preparation commands run at the task worktree root. Supply project directories
through their arguments, and allow enough time for a fresh restore (up to 600000 ms).
Commands, timeouts and file permissions are part of the plan approval. Validation
and acceptance still require unchanged repository inputs; setup does not count as
passing validation or acceptance evidence. Plans without preparation keep their
existing behavior. Existing tasks need an explicit plan revision and approval to
add these commands; they are never injected into an already approved recipe.

The dashboard shows preparation progress, commands and retained output. A failed
or interrupted preparation stops before validation. **Retry preparation** (CLI:
`task-retry`) reruns just that step in the same attempt, preserving implementation.
Only changes permitted by its original preparation scope can be carried forward.
After controller loss, recover first: an already-settled preparation is adopted
without replay, while an uncertain command retains ownership until its process
settlement is proved. Recovery itself never launches another command.

## Revise a settled plan

```sh
npm start -- task-revise <task-id> <current-version> revised-plan.json
```

Supply the complete revised recipe, retaining its pinned base and workspace identity
once a workspace exists. The dashboard offers **Revise this task’s plan**, with outcome,
approach and repair-policy fields plus an advanced editor for scope, checks, criteria
and slices. Revision increments the task version, closes idle old executions and clears
approval and current evidence. Files, commits, history and pending decisions survive.
Delivered slice definitions and recipes must stay identical; revise remaining slices
or append a follow-up. Every revised plan must have remaining work.

The approval digest binds the retained workspace artifact, HEAD and instructions.
Changed bytes before the first revised execution block continuation until another
revision is approved. After approval, a fresh execution and exact file authorization
are required, followed by validation, explicit simplification, independent review and
acceptance. Existing partial edits remain available. Live or uncertain owners must
settle or recover before revision; this operation performs no Git writes.

## Bounded review repair and arbitration

An optional approved recipe field enables the review loop:

```json
"reviewPolicy": {
  "repairRounds": 2,
  "arbitrator": { "provider": "codex" }
}
```

Omitting the policy keeps manual retry. Approve 0–2 repair rounds; the arbitrator
is optional. Only a settled independent review with concrete blocking findings can
consume a repair round. Grampus preserves findings and files, creates a fresh attempt,
and stops for file authorization. Each repaired artifact still needs its own explicit
simplification assessment before fresh review. Failures and questions never silently
spend another inference attempt. The allowance persists through restart and manual
retry, and resets for a new slice or newly approved revision.

After the repair allowance, the configured arbitrator receives a fresh artifact-bound
review session and prior verdicts with their artifact identities. A same-provider
arbitrator is an explicitly approved, recorded fallback. An unresolved arbitration
blocks delivery. Recovery reconciles recorded results without rerunning inference.

## Acceptance observations

Legacy `acceptance.expectedStdout` remains supported. Alternatively, or additionally,
an acceptance command can approve these observations:

```json
"expectations": {
  "stdoutJson": { "ok": true, "count": 2 },
  "stderr": "",
  "files": [
    { "path": "result.json", "content": "{\"ok\":true}\n" },
    { "path": "asset.bin", "sha256": "<64 lowercase hexadecimal characters>" },
    { "path": "obsolete.txt", "absent": true }
  ]
}
```

JSON comparison ignores object-key order and whitespace while preserving value types
and array order. A file with only a path asserts presence. Content and binary hashes
are compared to the verified snapshot, not an extra filesystem read. Absence requires
a recorded snapshot tombstone; paths outside the captured inventory, including ignored
outputs, cannot establish an assertion. Commands still need exit 0, confirmed descendant
settlement, complete retained output and unchanged repository inputs. Use a command to
observe UI behavior or external services and emit an approved JSON result; these are
command observations, not built-in browser verification. Every active criterion must
still be mapped and independently reviewed for semantic sufficiency.

## Inspect and authorize files

The first run creates the isolated workspace and a fresh implementation session,
captures repository instructions and files, checks the editing policy and verifies
that the repository fits the existing review limits. It stops before inference:

```sh
npm start -- task-show <task-id> --details
npm start -- task-authorize <task-id>
```

Inspect the named files in the displayed workspace. `--details` includes retained
instructions and changes. Authorization binds to that exact snapshot; changed
files or instructions cannot be silently substituted before editing. The runner
fills in content digests and session/check ids rather than requiring hand-written
per-command JSON files.

The provider edits only the declared scope. Validation runs next and successful
implementation is submitted. Failures stop the workflow with retained results.
For a question, supply a JSON map of all question ids to answers using
`task-answer <task-id> answers.json`. Implementation answers prepare a fresh scope
checkpoint before another editing turn; review answers resume the recorded review
session after artifact revalidation.

## Assess, review and deliver

At `awaiting_assessment`, inspect the code and retained check output. Choose an
explicit simplification outcome and explain it:

```sh
npm start -- task-show <task-id> --details
npm start -- task-assess <task-id> --outcome passed --summary "One direct statement follows the repository convention; no duplication or extra abstractions."
```

Use `failed` or `skipped` when appropriate; those outcomes are retained and stop
before review. A passing assessment continues with a fresh independent review,
exact-output acceptance and supervised local delivery. Blocking findings and
unanswered questions stop progression. Completion and the report use the existing
controller gates; a model reply alone cannot complete a task.

```sh
npm start -- report <task-id>
```

For ordered slices, include the existing approved `brief.slices` and an equally
long execution `slices` array. Each slice has its own scope, validation, acceptance
and delivery message. Delivery prepares the next slice's scope checkpoint. Final
review covers integration and final acceptance maps to every task criterion.

Use `mode: "no_change"` with `scope: { "files": [] }` to confirm an already satisfied
outcome without implementation inference or an empty commit. Validation, explicit
simplification, independent review and acceptance still run.

## Stop, retry and recover

Guided agent turns have no automatic runtime deadline, including planning, implementation,
review and arbitration. Old saved agent timeout fields remain in their approved digests
for compatibility but no longer terminate turns. **Stop** and controller-loss supervision
remain active; validation and acceptance commands retain their approved timeouts.

Ctrl+C requests interruption. Another terminal can use `task-stop <task-id>`;
the runner observes that request and waits for its owned processes to settle.
A stop request is distinct from confirmed shutdown.

Use `task-retry <task-id>` after a settled failure or at a scope/simplification
checkpoint when changes are needed. Inspect retained files, findings and any
delivery changes first. At a failed preparation step, it retries preparation in
the same attempt without repeating implementation. At other checkpoints it
creates a fresh attempt/session,
preserves partial files, carries review feedback and prepares a fresh authorization
checkpoint. It does not reset Git or automatically alter the approved scope.
For a deletion-only slice whose files are already absent, authorizing the fresh
checkpoint proceeds directly to validation. It still requires fresh simplification,
independent review, acceptance and delivery; the original commit delivery mode is
preserved, and no empty editing policy or redundant implementation turn is created.

After a controller exits unexpectedly:

```sh
npm start -- task-show <task-id>
npm start -- task-recover <task-id>
```

Recovery first proves the previous controller exited, then invokes the applicable
existing receipt-based recovery. It can adopt an exact already-settled result or
leave the task blocked when proof is unavailable. It never sends a provider turn,
stages files, commits or automatically runs the next step. Continue explicitly
with the displayed command. The underlying recovery command is also displayed.

One guided controller at a time owns the runner in a journal. Ownership survives
uncertain shutdown, preventing another guided task from starting. Low-level CLI
commands, other journals, editors and independently launched Orca agents remain
outside that global guided limit. Avoid mixing controllers for the same task.
Task and workspace leases still enforce their existing ownership rules.

`task-show --json` exposes the saved plan, state, questions, findings and leaf
operation results for tooling. `--db <journal.sqlite>` works with every command.
Keep the journal and plan outside task worktrees. No background recovery or
automatic retention cleanup is enabled.

If standalone creation failed before producing a checkout, use
`task-release-workspace <task-id>` (or **Release unused reservation** in the dashboard).
It requires confirmed Git exit, absent checkout files and no Git worktree registration,
executions or active lease. It releases metadata only; branches, files and history are
never deleted. A later explicit Continue creates a new worktree with a fresh branch.
The low-level equivalent is `workspace-release <workspace-id>`. Existing checkouts,
unknown Git exit and uncertain Orca creation remain blocked for inspection/recovery.

New ordinary conversations and workspace operations record exact Windows process
creation times, so a recycled PID does not impersonate the original owner. A durable
pre-connection boundary can prove that a crashed conversation never requested provider
startup. Once connection was requested, a missing provider identity still cannot prove
shutdown. Legacy records remain conservative; native editing always requires its
supervisor receipt rather than conversation recovery.

Task views and reports aggregate the latest cumulative usage per provider session,
including linked planning and naming sessions. They count resumed sessions once,
include failed attempts and earlier versions, separate providers and mark partial or
unknown measurements. Estimated USD never becomes billed cost; billed cost stays unknown.
