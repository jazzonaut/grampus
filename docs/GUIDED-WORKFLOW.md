# Guided tasks from the CLI

Most people should use the [dashboard](DASHBOARD.md), which writes the plan for you
through a planning conversation. This guide covers authoring a plan as JSON and
driving it with the `task-*` commands. Both use the same controller and journal.

New plans run in **automatic** mode by default: approval authorizes the listed files
and commands, and Grampus runs implementation, validation, independent review,
bounded repairs, acceptance and local delivery without further input unless
something needs attention. **Supervised** mode is opt-in and adds two manual
checkpoints per attempt. See [WORKFLOW.md](WORKFLOW.md) for the automatic behaviour.

## Write a plan

Start from [examples/guided-task.json](../examples/guided-task.json) and adapt it to a
small existing repository with a committed baseline. The example sets
`workflowPolicy.mode` to `supervised` so you can step through every checkpoint; remove
that field to use the automatic default.

A plan contains:

- `brief`: title, outcome, criteria, plan and optional ordered `slices`.
- `workspace`: `repo`, `base`, and either `path` for a standalone Git worktree or
  `adapter: "orca"`. Paths are relative to the plan file. A standalone destination
  must not exist; its parent must.
- `implementation` and optional `review`: provider and model. The default implementer
  is Codex, and review always uses the other provider.
- `slices`: one execution configuration per brief slice (one for an unsliced brief),
  each with a file `scope` (`files`, `create`, `delete`), `validation`, `acceptance`,
  a delivery `message`, and optional `preparation` and `mode`.
- Optional `workflowPolicy`, `reviewPolicy`, top-level `preparation`, `context` and
  `references`.

Commands use `name`, `file`, `args` and `timeoutMs` (default 120000, at most 600000).
There is no shell. `file: "node"` resolves to the current Node executable; other
executables need absolute paths. Commands run at the task worktree root.

Repository exploration is enabled by default, so file hints are optional. Exact file
scope supports regular UTF-8 files up to 1 MiB each and 4 MiB of existing text per
slice. Unsupported sizes fail at planning, before approval. See
[repository context](REPOSITORY-CONTEXT.md).

## Approve and run

```sh
grampus task-new my-plan.json
grampus task-approve <task-id> 1 <displayed-plan-digest>
grampus task-run <task-id>
```

`task-new` stores a draft and pins the base to a commit; it creates no worktree and
calls no provider. It prints the approval digest, which covers the whole plan. Copy
the displayed approval command after inspecting it. Plain `approve` does not
authorize a guided plan. `task-show <task-id> [--details|--json]` shows progress, the
next action, questions, findings and retained results.

`task-run` advances until the task completes or something needs input. Ctrl+C or
`task-stop <task-id>` from another terminal requests a stop; the runner waits for its
owned processes to settle. From a checkout, use `npm start --` in place of `grampus`.

## What stops a run

- **Questions.** Answer every question id with `task-answer <task-id> answers.json`,
  where the file is a JSON object mapping ids to text.
- **Failures beyond the allowance.** Validation and acceptance failures are repaired
  automatically up to `workflowPolicy.repairRounds`; a repair that leaves the failing
  content unchanged stops early.
- **Blocking review findings beyond the allowance**, or an unresolved arbitration.
- **Operational problems:** preparation failures, scope errors, uncertain process exits
  and anything that needs recovery.

Inspect the retained files, findings and check output, then use `task-retry`. Valid
tests and acceptance criteria must not be weakened to make them pass.

## Supervised mode

With `"workflowPolicy": { "mode": "supervised" }`:

1. Before each editing turn the task stops at `awaiting_scope`. Inspect the files with
   `task-show <task-id> --details`, then run `task-authorize <task-id>`. Authorization
   binds to that exact snapshot.
2. After validation and submission it stops at `awaiting_assessment`. Inspect the code
   and record a simplification outcome:

   ```sh
   grampus task-assess <task-id> --outcome passed --summary "One direct statement; no duplication or extra abstractions."
   ```

   `failed` or `skipped` is retained and stops before review.

Review, acceptance and delivery then follow as in automatic mode. Failed checks stop
for `task-retry` instead of being repaired automatically. Blocking review findings
start a repair attempt within the review allowance, and that attempt again stops for
authorization and assessment. To change the mode, revise the plan and approve it again.

## Repository preparation

Fresh worktrees have no ignored dependencies. An approved top-level `preparation`
command runs before scope in every attempt and again after implementation, before
validation. A slice's own `preparation` replaces the second run and may update only
that slice's authorized paths, such as a lockfile after a manifest change. Include
generated paths in the slice scope; the implementer cannot run commands. The planner
infers these commands from the repository; Grampus does not detect package managers.
Preparation is not validation or acceptance evidence.

A failed preparation stops before validation. `task-retry` reruns only that step in
the same attempt.

## Review policy and arbitration

```json
"reviewPolicy": { "repairRounds": 2, "arbitrator": { "provider": "codex" } }
```

`repairRounds` is 0 to 2. Only a settled review with concrete blocking findings spends
a round; Grampus keeps the findings and files and starts a fresh attempt. Without a
`reviewPolicy`, review repairs use the workflow allowance, up to two; `repairRounds: 0`
stops for a manual retry. After the allowance, an optional arbitrator receives a fresh
artifact-bound review with all earlier verdicts. A same-provider arbitrator is an
explicitly approved fallback. More than eight verdicts or 128 KiB of history stops
before inference rather than dropping findings.

## Acceptance observations

`acceptance.expectedStdout` checks exact stdout. Alternatively or additionally:

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

JSON comparison ignores key order and whitespace. File assertions use the verified
after-snapshot, so ignored outputs cannot satisfy them. Commands still need exit zero,
settled descendants, complete output and unchanged inputs. Grampus checks the
observations, not whether the checks are sufficient: make them demonstrate the
intended behaviour.

## Slices and no-change delivery

For ordered slices, supply `brief.slices` and an equally long execution `slices`
array. Each slice is delivered as its own verified commit before the next begins.
Final review covers integration and final acceptance maps to every task criterion.
Use `mode: "no_change"` with `scope: { "files": [] }` to confirm an outcome that
already exists, without editing or an empty commit; every gate still runs.

## Revise a plan

```sh
grampus task-revise <task-id> <current-version> revised-plan.json
```

Supply the complete revised plan at a settled checkpoint, keeping the pinned base and
workspace. Revision increments the version, closes idle executions and clears approval
and current evidence. Files, commits, history and delivered slices are kept;
delivered slice definitions must not change. The new digest binds the retained
workspace content, so changes made before the first revised execution block it.
Fresh approval is required.

## Recover after a crash

```sh
grampus task-show <task-id>
grampus task-recover <task-id>
```

Recovery first proves the previous controller exited, then applies the matching
receipt-based recovery for the interrupted step. It adopts an exact settled result or
leaves the task blocked. It never sends a provider turn, stages, commits or starts the
next step; continue with the displayed command.

If standalone worktree creation failed before producing a checkout,
`task-release-workspace <task-id>` releases the reservation metadata after confirming
Git exited and nothing was created. Branches, files and history are never deleted.

One guided controller runs per journal at a time, and its ownership survives an
uncertain shutdown. Keep the journal and plan files outside task worktrees. Every
command accepts `--db <path>`; the default journal is `grampus.sqlite` in the data
directory ([INSTALLATION.md](INSTALLATION.md#develop-alongside-the-installed-app)).
