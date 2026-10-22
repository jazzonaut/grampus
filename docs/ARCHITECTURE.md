# Architecture

Current behaviour of Grampus. Intent and the reasons behind it are in [DESIGN.md](../DESIGN.md).

## Overview

```text
  chat agent / CLI / dashboard (Planned)
          │  queue commands (commands.jsonl), read state (events.jsonl)
          ▼
  task driver  ── one process per task, in the task's own Orca terminal
     │   records events, runs checks and the guard, decides rounds
     │   orca orchestration ... --json (only writer to the task's Run)
     ▼
  Orca  ── Run, tasks, dispatches, gate, inbox, liveness
     │   worker-start --agent claude|codex  (chat or terminal, per the user's setting)
     ▼
  workers  ── spec, spec review, tests, build, review, repair
             write files under <worktree>/.grampus/, commit on the task branch
```

`grampus new` creates the task folder and log, an Orca worktree (`worktree create --no-parent
--setup run`), and an Orca terminal in that worktree whose command is `grampus drive <task> && exit`, so the tab
closes (releasing its hold on the worktree) when the task finishes, and stays open after a stop. The
driver runs inside that terminal, so Orca resolves it as the Run's coordinator without `--from`.

## Module map

| Folder | Module | Owns |
| --- | --- | --- |
| `src/` | `cli.ts` | Commands; every control verb queues a command for the driver |
| | `skill.ts` | Renders and installs the chat skill from `skills/grampus/SKILL.md` |
| `config/` | `limits.ts`, `settings.ts`, `paths.ts` | Fixed bounds, operational settings, data directory |
| `domain/` | `recipe.ts` | Recipe schema, the built-in `standard` recipe, family checks |
| | `spec.ts` | Spec parsing: one fenced `grampus` JSON block with checks and protected paths |
| | `review.ts` | Review reports and the blocking rule |
| | `events.ts` | The event log schema and user command schema |
| `orca/` | `client.ts`, `protocol.ts` | The Orca CLI client and the JSON it reads |
| `git/` | `git.ts` | Read-only Git queries |
| `measure/` | `transcripts.ts` | Reading models, effort and tokens from Claude and Codex transcripts |
| | `usage.ts` | Per-dispatch measurements, splitting continued conversations by request time |
| | `report.ts` | The scorecard: per-stage figures, totals and human cost |
| `checks/` | `run-checks.ts` | Running check commands with logs, timeouts and one flaky rerun |
| `store/` | `task-store.ts` | Task folders, `events.jsonl`, `commands.jsonl` |
| `pipeline/` | `driver.ts` | Driver entry point and lock |
| | `driver-core.ts` | Recording, request ids, inbox pump, commands, decisions, running a stage |
| | `pipeline.ts` | Stage order: run, gate, spec, tests first, baseline, rounds, finish |
| | `spec-phase.ts` | Spec writing, automatic correction, spec review, approval |
| | `guard.ts` | The deterministic integrity guard |
| | `prompts.ts` | Worker task specs |
| | `state.ts`, `status.ts` | The fold from events to state, and summaries |
| | `create-task.ts` | `grampus new` |

## Pipeline

1. **Run and gate.** The driver creates its Run and an approval gate on a placeholder Orca task, so
   the pending decision is visible in Orca.
2. **Spec** (`spec:<n>`). A worker writes `<worktree>/.grampus/spec-<n>/spec.md`. Grampus parses it;
   an unusable file is sent back once (`specLimits.automaticCorrections`) with the error, then the user
   decides. Valid specs become versions, copied to `<task>/spec/v<version>.md`. Revisions and
   corrections try to continue the previous spec conversation (see reuse below) and always list the
   questions the user already answered, so a fresh writer does not ask them again.
3. **Spec review** (`spec-review:<version>`, optional). Starts as soon as the spec is recorded and runs
   alongside the approval request, so the user sees the spec without waiting for it. Its findings are
   added to the request when it lands; a blocking finding or a failed review raises the request again.
   A review still running when the user decides is stopped (`stage.stopped`) and recorded as such.
4. **Approval.** `approve` must name the latest version. `status` and `wait` print the spec text and
   its review with the request, and every accept or escalation request prints the round's evidence
   (commits, changed files, checks, integrity problems, review findings, reasons), so a chat agent can
   show it before asking. The gate is resolved and the approved spec is
   written to `<worktree>/.grampus/spec.md` for later workers.
5. **Tests first** (`tests:0`, optional). Added files become protected.
6. **Baseline.** Checks run at HEAD before the build, without reruns.
7. **Rounds.** Round 0 is `build:0`; round `r` is `repair:<r>`. Repair rounds up to
   `recipe.repair.reuseBuilderRounds` try to continue the previous editor's conversation when the
   assignment is unchanged; later rounds start a fresh worker with the distilled problems.

   **Reuse.** Continuing a conversation passes the settled worker's handle to `worker-start --terminal`.
   Only terminal-mode workers accept a second dispatch. Workers started in Orca's Chat UI mode are
   structured workers, which Orca refuses (`terminal_unsupported_for_agent_session`, nothing applied).
   Grampus then records `stage.reuse_refused`, starts a fresh worker, and stops trying for the rest of
   the task.
8. **Verify.** The guard compares the round's start commit with HEAD: uncommitted or untracked files,
   no new commit, rewritten history, protected paths changed, test files deleted or renamed out of the
   test patterns. Modified tests are listed for the reviewer. Then every check runs at HEAD; a failing
   check runs once more and a pass is recorded as flaky.
9. **Review** (`review:<r>`, optional). The reviewer sees the whole change since the build started,
   the check results, modified tests and the previous round's blocking findings. Only findings with a
   file, a line and a scenario block; others are kept as downgraded notes.
10. **Decision.** Ready when there are no guard violations, failing checks or blocking findings. A
    builder that reported failure, or an unavailable review, escalates immediately. Otherwise repair
    while `round < maxRounds + continues`, then escalate.
11. **The user** accepts (recorded as an override after escalation), continues with guidance (one more
    round) or abandons. Finishing releases every worker: settled ones with `worker-release`, unsettled
    ones with `worker-stop`. When every check already passed at the baseline, the acceptance request
    says so: those checks show no regression but do not demonstrate the new behaviour.

## Durability and recovery

- Every Orca mutation's request id is recorded (`orca.requested`) before the call and passed as
  `--retry-request`. Orca replays a repeated id with the original receipt, so after a crash or an
  uncertain result the driver simply repeats the call. An uncertain result stops the driver
  (`driver.stopped`); running `grampus drive <task>` again resumes.
- The inbox is acknowledged only on the next `check` after every message is recorded. Replayed
  messages are skipped by id.
- A settled worker is retained before its message is acknowledged and released when the task finishes.
- A worker is treated as gone only on Orca's positive `exited` liveness verdict. Start failures and
  exits wait for the user (`retry` or `abandon`); `retry` stops an `outcome_unknown` start first and
  passes `--retry-of`.
- Decisions are keyed (`approve-spec:2`, `ready:1`, `escalate:0`, `stage-failed:build:0:1`), so a
  restarted driver finds a decision already made instead of asking again.
- A driver started in a different terminal rebinds the Run with `run-use`.
- `driver.lock` in the task folder stops a second driver for the same task.

## Files

```text
<data>/config.json                       optional settings
<data>/tasks/<task>/events.jsonl          append-only event log (schema 1)
<data>/tasks/<task>/commands.jsonl        queued user commands
<data>/tasks/<task>/spec/v<n>.md          spec versions and their reviews
<data>/tasks/<task>/reviews/round-<r>.json
<data>/tasks/<task>/checks/<phase>-<r>/   check logs
<worktree>/.grampus/                      files exchanged with workers (excluded from Git)
```

The data directory is `GRAMPUS_HOME`, or `%LOCALAPPDATA%\Grampus\orca` on Windows. `.grampus/` is
excluded through the repository's `info/exclude`, the only change Grampus makes to Git metadata; it
never writes commits, branches or the index.

## Orca contract

Observed on Orca 1.4.237 (October 2026). Re-check after upgrades.

- `run-create` outside an Orca terminal binds whichever terminal is active; a made-up `--from` handle
  is refused (`stable_pane_required`). Grampus therefore runs each driver in its own Orca terminal.
- One terminal coordinates one Run: a second `run-create` from it fences the first (`consumer_fenced`).
- An agent session cannot pass another caller's `--from` or `--terminal`.
- `--retry-request` must be a UUID. The first call executes; a repeat returns `replayed: true` with the
  same receipt. `request-show` reports `completed`, `pending` or `absent`.
- A gate turns its task `blocked` until resolved.
- `worker-start` exits non-zero for `failed` and `outcome_unknown` receipts but still prints them.
- `worker-show` rows are camelCase (`assigneeHandle`, `agentTerminalHandle`); `run-create` and message
  rows are snake_case (`coordinator_handle`, `created_at`).
- A structured (Chat UI) worker cannot take a second dispatch; its handle is `structworker_...`.
- `worker-read --source transcript` drops models and usage; its message ids name the provider session.
- `worker_done` payloads carry `taskId`, `dispatchId`, `outcome`, optional `filesModified`,
  `reportPath` and `phase`, as a JSON string.
- There is no per-Run delete, and `orchestration reset` wipes all orchestration state.
- Plugin sidebar panels cannot reach a local server (`connect-src 'none'`).

## Measurements

The event log records the recipe snapshot, Orca version, every dispatch (requested and effective
launch, request, start and settle times, outcome), every check (exit code, duration, timeout, flaky) on
base and head commits, guard results, review findings and downgrades, round decisions with reasons,
every user command with its source, and how long the task waited for the user.

When a task finishes, after its workers are released, the driver records `usage.recorded`: for each
dispatch, the provider, the model that actually ran, effort (Codex), time from start request to report,
and tokens. Orca's transcript view drops models and usage, but its message ids name the provider
session (`claude:<session>:...`, `codex:<session>:...`). Grampus reads that session's transcript:
Claude's `<projects root>/<project>/<session>.jsonl` (usage once per message id) and Codex's
`<sessions root>/YYYY/MM/DD/rollout-...-<session>.jsonl` (growth of the cumulative total). A
conversation continued by a later dispatch is split at the time that dispatch was requested. `input`
counts uncached input for both providers. Anything not found stays unknown with a note.

`grampus report <task>` prints the scorecard: per-stage figures, totals, rounds, wall time and the
human cost (decisions, how many came from chat, time spent waiting). For a running task it measures
now and is marked provisional. **Planned:** comparisons, exports and the dashboard.
