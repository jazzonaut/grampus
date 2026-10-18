# Guided Windows task workflow

The guided CLI connects the existing task controller into a repeatable workflow.
It prepares workspaces and sessions, runs native implementation and validation,
pauses for explicit simplification, then runs independent review, acceptance and
verified local delivery. It prints the next command at each checkpoint.

For plain-language kickoff and on-screen controls, use the
[local dashboard](DASHBOARD.md). This document describes the authored-plan CLI.
This is an early Windows interface with bounded text context inside larger repositories.
See [repository context and scale](REPOSITORY-CONTEXT.md) for selection and limits. Automated review
repair/arbitration remains work.
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
the underlying brief/version invalidate guided continuation. Editing and rebinding
guided recipes is not implemented yet; use a new draft for a different plan.

The default implementer is Codex and the reviewer is Claude. Select Claude
implementation to default to Codex review. The guided path requires different
providers; it never chooses a same-provider fallback implicitly. Existing first-party
subscription authentication remains required. No automatic inference retries are
enabled, and no branch is pushed.

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

Ctrl+C requests interruption. Another terminal can use `task-stop <task-id>`;
the runner observes that request and waits for its owned processes to settle.
A stop request is distinct from confirmed shutdown.

Use `task-retry <task-id>` after a settled failure or at a scope/simplification
checkpoint when changes are needed. Inspect retained files, findings and any
delivery changes first. It creates a fresh attempt/session,
preserves partial files, carries review feedback and prepares a fresh authorization
checkpoint. It does not reset Git or automatically alter the approved scope.

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
