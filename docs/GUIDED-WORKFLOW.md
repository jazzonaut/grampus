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
- Optional `workflowPolicy`, `reviewPolicy`, `quality`, top-level `preparation`, `context`
  and `references`. `quality.passes` lists quality pass ids or full definitions; it defaults
  to the configured `defaultQualityPasses` ([quality passes](WORKFLOW.md#quality-passes)).

Commands use `name`, `file`, `args` and `timeoutMs` (at most 600000). An omitted timeout
defaults to 600000 for preparation and 300000 for validation and acceptance, or the configured
`defaultPreparationTimeoutMs` and `defaultCheckTimeoutMs` ([configuration](CONFIGURATION.md)).
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

`task-pause <task-id>` lets the current operation finish, then pauses before another starts.
The stop reason is `USER_PAUSED`. Use `task-run <task-id>` to continue the same attempt,
keeping its files, conversations and evidence. A failure, question or uncertain settlement
keeps its own reason instead. A requested pause is a normal CLI outcome, not a failed run.

## What stops a run

- **Questions.** Answer every question id with `task-answer <task-id> answers.json`,
  where the file is a JSON object mapping ids to text.
- **Failures beyond the shared allowance.** Validation, review and acceptance use
  `workflowPolicy.repairRounds` (three by default, 0 to 10 approvable). Unchanged failing
  content, unresolved prior review blockers or missing progress evidence stop early.
- **Unresolved arbitration.** A fresh arbitrator can be selected in the approved plan.
- **Operational problems:** preparation failures, scope errors, uncertain process exits
  and anything that needs recovery.

Inspect the retained files, findings and check output, then use `task-retry`. Valid
tests and acceptance criteria must not be weakened to make them pass.

When a check stopped for an infrastructure reason, such as `CHECK_TIMEOUT`, on an unchanged
artifact, `task-show` offers `task-rerun-checks <task-id> <decision-key>` as the next action.
It reruns the same check without an agent turn or a new implementation attempt
([rerun checks](WORKFLOW.md#rerun-checks)). The decision key is the digest of the state you
inspected, so a command copied before the task changed is refused.

## Supervised mode

With `"workflowPolicy": { "mode": "supervised" }`:

1. Before each editing turn the task stops at `awaiting_scope`. Inspect the files with
   `task-show <task-id> --details`, then run `task-authorize <task-id>`. Authorization
   binds to that exact snapshot.
2. After validation and submission it stops at `awaiting_assessment` when the plan selects
   quality lenses. Inspect the code and record one outcome covering every selected lens:

   ```sh
   grampus task-assess <task-id> --outcome passed --summary "One direct statement; no duplication or extra abstractions."
   ```

   It is recorded as evidence for each selected lens. `failed` or `skipped` is retained and
   stops before review.

Review, acceptance and delivery then follow as in automatic mode. Failed checks stop
for `task-retry` instead of being repaired automatically. Blocking review findings
start a repair attempt within the shared allowance, and that attempt again stops for
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
"reviewPolicy": { "arbitrator": { "provider": "codex" } }
```

Only a settled review with concrete blocking findings or a failed selected quality lens
spends a shared round. Grampus retains findings and files, checks artifact changes and asks
the next reviewer to account for every preceding blocker by controller identity. Further
automatic repair requires those blockers to be resolved with evidence; a new related defect
can then use the remaining allowance. A passing review also needs complete dispositions.

If progress stalls, evidence is missing or the shared allowance is exhausted, an optional
arbitrator receives a fresh artifact-bound review with all earlier verdicts. A same-provider
arbitrator is an explicitly approved fallback. More than twelve verdicts or 128 KiB of history
stops before inference rather than dropping findings. See [repair policy](WORKFLOW.md#configuration).

## Acceptance observations

`acceptance.expectedStdout` checks exact stdout. Exit status alone never accepts, so every acceptance
command needs `expectedStdout`, `expectations` or both; an error names the slice
whose command lacks them. Alternatively or additionally:

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

## Task spending limits

New plans approve 20 task-wide provider turns and no token threshold by default. Set
`workflowPolicy.maxTaskTurns` and `workflowPolicy.maxTaskTokens` (0 disables the token gate) in the
plan before approval. Counts include linked planning, retries, all slices and all plan versions.
Grampus checks before each agent turn; an active turn finishes normally and may exceed the token
threshold. Missing token usage stops further turns when a token threshold is enabled.

`task-show` and the report display the allowance. A spending stop requires `task-revise` with a
higher cumulative total or an explicit token-policy change, followed by fresh approval. Retrying
or restarting never resets it. See [spending semantics](WORKFLOW.md#task-wide-spending-allowances).

## Queue guidance

Save a JSON file such as `guidance.json`:

```json
{ "text": "Keep the implementation direct and inspect the error path.", "target": "next_agent" }
```

```sh
grampus task-guide <task-id> guidance.json
grampus task-show <task-id> --details
grampus task-cancel-guidance <task-id> <message-id>
```

Targets are `next_agent`, `implementer` (implementation and edit passes) or `reviewer`
(independent review and arbitration). Guidance waits for a matching future turn, without starting
one or interrupting the current turn. It cannot change approval or replace structured answers.
Only queued messages can be cancelled. Remaining messages stop delivery with `GUIDANCE_PENDING`;
cancel them and explicitly continue, or revise the plan. See [guidance rules](WORKFLOW.md#guide-a-future-agent-turn).

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

One guided controller runs per task at a time, and up to `maxConcurrentTasks` guided tasks
(2 by default, see [CONFIGURATION.md](CONFIGURATION.md)) run at once per journal, each in its
own worktree. When every slot is taken, `task-run` and the other commands that start work
(`task-authorize`, `task-assess`, `task-answer`, `task-retry`, `task-rerun-checks`) are
refused with a message naming the running tasks; nothing is queued, so run the command again
once a slot is free. Recovery, revision and `task-release-workspace` are never refused for a
full pool. A controller's ownership survives an uncertain shutdown and keeps its slot until
`task-recover` settles it. Keep the journal and plan files outside task worktrees. Every
command accepts `--db <path>`; the default journal is `grampus.sqlite` in the data
directory ([INSTALLATION.md](INSTALLATION.md#develop-alongside-the-installed-app)).
