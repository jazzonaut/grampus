# Architecture

Current behaviour of Grampus. Intent and the reasons behind it are in [DESIGN.md](../DESIGN.md).

## Overview

```text
  chat agent / CLI / dashboard
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
--setup run`), and an Orca terminal in that worktree whose command is `grampus drive <task>` (by full
path; see [Installation](#installation)). The repository is `--repo`
or the current folder's, resolved through `git rev-parse --git-common-dir` to the main checkout, which
is how Orca knows repositories. Orca opens a first terminal in every new worktree; Grampus closes it
once the driver tab exists, so a task has exactly one tab. After a clean finish the driver closes its
own tab through `orca terminal close`, so no shell holds the worktree open; a stopped driver keeps its
tab. The
driver runs inside that terminal, so Orca resolves it as the Run's coordinator without `--from`.

Clients read state from the logs. `status`, `wait` and `new` print `as of <time>`; `wait --after <time>`
returns anything newer (a decision request, a question, a stopped driver, a finish), including what happened
between two calls, such as a spec review landing while an agent talked to the user.

## Module map

| Folder | Module | Owns |
| --- | --- | --- |
| `src/` | `cli.ts` | Commands; every control verb queues a command for the driver |
| | `commands.ts` | The command catalog behind `--help` and the dashboard's Help page |
| | `control.ts` | Queueing a validated command; shared by the CLI and the dashboard |
| | `skill.ts` | Renders and installs the chat skill from `skills/grampus/SKILL.md` |
| `config/` | `limits.ts`, `settings.ts`, `paths.ts` | Fixed bounds, operational settings, data directory |
| `install/` | `installation.ts` | Installation layout, build identity, launcher; whether this process is installed |
| | `install.ts`, `main.ts` | `npm run install:local`: copy, smoke check, select, PATH, skill, prune |
| | `update.ts` | `grampus update`: reinstall from the recorded checkout |
| `domain/` | `recipe.ts` | Recipe schema, the built-in `standard` recipe, family checks |
| | `spec.ts` | Spec parsing: one fenced `grampus` JSON block with checks and protected paths |
| | `review.ts` | Review reports and the blocking rule |
| | `events.ts` | The event log schema and user command schema |
| `orca/` | `client.ts`, `protocol.ts` | The Orca CLI client and the JSON it reads |
| `compare/` | `comparison.ts` | Comparison log, commands and fold |
| | `create.ts`, `driver.ts` | Starting a comparison; its driver: entries, shared spec, pick |
| | `cross-check.ts`, `status.ts` | Every spec against every result; comparison status text |
| `agents/` | `catalog.ts` | Models and effort levels per agent, read from the Claude and Codex CLIs |
| `git/` | `git.ts` | Read-only Git queries |
| `measure/` | `transcripts.ts` | Reading models, effort and tokens (per model) from Claude and Codex transcripts |
| | `cost.ts` | Estimated cost at API list prices, with the dated built-in price table |
| | `usage.ts` | Per-dispatch measurements, splitting continued conversations by request time |
| | `report.ts` | The scorecard: per-stage figures, totals and human cost |
| `checks/` | `run-checks.ts` | Running check commands with logs, timeouts and one flaky rerun |
| `store/` | `task-store.ts` | Task folders, `events.jsonl`, `commands.jsonl` |
| `dashboard/` | `server.ts`, `http.ts` | `grampus dashboard`: static web app, JSON API, request guards |
| | `api.ts` | API routes |
| | `actions.ts` | Starting tasks, merge, Orca tabs, recipe edits and the model catalog |
| | `views.ts`, `timeline.ts`, `types.ts` | Task views built from the fold, and the JSON contract the web app imports |
| | `tasks.ts` | Cached log reads and the change watcher behind live updates |
| `web/` | `app/` | The dashboard: Vue 3, Nuxt UI, built into `dist/web` |
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
   added when it lands, with a fresh request (which wakes `grampus wait`) carrying its findings.
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

## Dashboard

`grampus dashboard [--port <n>]` serves the built web app (`dist/web`) and a JSON API from one Node
process, on port 4545 and every interface by default, so a phone on the same network can use it. It
prints the addresses it answers on.

- **Reads** come from the same fold the driver uses (`TaskReader` caches folds by log size). Views add the
  pipeline strip, spec versions with their text and review, worker messages with their answers, rounds
  with guard, checks and review, queued commands and a plain-language timeline.
- **Writes** queue commands with source `dashboard`, exactly like the CLI; the driver stays the only
  writer to its Run and log. The few actions the CLI takes outside a driver are offered too: starting
  a task (`grampus new`, with Orca's repositories and recent ones to pick from), `grampus merge`, and
  bringing the driver terminal or the changed files forward in Orca (`terminal switch`,
  `file open-changed`), which acts on the Orca window of the machine running Grampus.
- **Recipes** can be created, copied, edited and deleted. They are written to `config.json` (other
  settings kept), validated with the same rules as at startup, and replaced in one rename. The model
  and effort lists come from `codex debug models` (a JSON catalog) and from `claude --help` (aliases
  and effort levels) plus Claude models seen in recipes and measurements; any model can be typed.
- **Live updates**: `/api/live` is a server-sent event stream. A watcher polls log and queue sizes every
  `waitPollMs` and sends the ids of tasks that changed; after a reconnect the page reloads everything.
- **Files**: only paths a task's log records (spec versions, check logs) can be fetched.
- **No login.** Anyone who can reach the port can control tasks. The guards stop other web pages from
  using a visitor's browser: requests must name one of this machine's host names or addresses (or
  `dashboardAllowedHosts`), so DNS rebinding fails; writes must carry the dashboard's own `Origin` and a
  JSON body, so cross-site forms and fetches fail; pages cannot be framed; a strict Content Security
  Policy and Markdown rendered without raw HTML contain agent output.
- Icons are bundled at build time, so the dashboard works without internet access.
- **Pages**: a task list (needs you first) beside the selected task, with its pipeline strip, the pending
  decision and its evidence pinned on top, and tabs for overview, spec versions with review, checks and
  review per round (with check logs), worker questions and answers, timeline, scorecard and the raw
  event log. The open tab is part of the address, so it can be bookmarked.
- **Attention**: the tab title counts tasks that need the user and the favicon gets a dot. Desktop
  notifications are offered where the browser allows them (localhost or HTTPS, so not on a phone over
  plain HTTP). A web app manifest lets it be added to a home screen.

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
<data>/comparisons/<id>/events.jsonl      comparison log (schema 1)
<data>/comparisons/<id>/commands.jsonl    queued picks and abandons
<data>/comparisons/<id>/cross-check/      cross-check logs
<worktree>/.grampus/                      files exchanged with workers (excluded from Git)
```

The data directory is `GRAMPUS_HOME`, or on Windows `%LOCALAPPDATA%\Grampus\orca` for an installed
build and `%LOCALAPPDATA%\Grampus\orca-dev` for a checkout. `.grampus/` is
excluded through the repository's `info/exclude`. Grampus writes no commits, branches or index entries,
with one explicit exception, `grampus merge` (below).

## Installation

```text
%LOCALAPPDATA%\Programs\Grampus  grampus-install.json            marks the folder; carries the layout version
  current.json                    { "build": "<build id>" }: the selected build
  bin\grampus.cmd, bin\launch.mjs  the command on PATH; reads current.json on every start
  versions\<build id>\            immutable: package.json, dist\src, dist\web, skills, node_modules, build.json
```

`npm run install:local` builds the checkout, then `install/main.ts` copies the runtime files into
`versions\<build id>` and installs production dependencies. It writes `build.json` last and runs
`grampus version --json` from the copy as a smoke check. Only then does it replace `current.json` in one
rename, so `grampus` runs the old build or the new one, never a partial copy. A build id is the package
version plus 12 characters of the commit; a dirty tree is refused unless `--dirty`, which appends
`.dirty.<UTC time>`. Reinstalling an installed build selects it again. Pruning keeps the selected build
and the newest others up to `keptVersions`, and removes folders without `build.json` (interrupted
installs). A lock file stops two installs running at once.

`grampus update` (`install/update.ts`) reads the running build's `build.json` for the checkout it came
from (or takes `--from`), does nothing when that checkout's clean `HEAD` is the running commit, and
otherwise runs the checkout's own `npm run install:local` with npm beside Node. It never fetches.

A version folder's `build.json` is how a process knows it is installed: it then uses the installed data
directory, and driver terminals run the launcher by full path (`node "<install>in\launch.mjs" --home
...`), so they work before Orca has picked up a PATH change and a restarted driver runs the newest build.
The chat skill runs `grampus` from PATH. Only an installed build installs the skill; a checkout prints
it but refuses to install it, so development never replaces the skill people use. A process keeps the
modules it loaded, but a long-running dashboard serves its web files from its version folder, so pruning
that version breaks its pages until it is restarted.

## Delivery

An accepted task's work is the verified commit on the task branch. `grampus merge <task>`
(`delivery/merge.ts`) is opt-in and only runs after acceptance: it fast-forwards the branch checked out
in the repository's main checkout to that exact SHA, never to later commits on the task branch, and
records `task.merged`. It refuses when the task was not accepted, no branch is checked out, the checkout
has uncommitted changes, or the branch has moved on so a fast-forward is impossible (then the user
merges or rebases the task branch). A repeat is harmless. It never pushes or opens pull requests.

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
dispatch, the provider, the model that actually ran, effort (Codex), time from start request to report
split into working time and time spent waiting for the user's answers to its questions, and tokens. Orca's transcript view drops models and usage, but its message ids name the provider
session (`claude:<session>:...`, `codex:<session>:...`). Grampus reads that session's transcript:
Claude's `<projects root>/<project>/<session>.jsonl` (usage once per message id) and Codex's
`<sessions root>/YYYY/MM/DD/rollout-...-<session>.jsonl` (growth of the cumulative total). A
conversation continued by a later dispatch is split at the time that dispatch was requested. `input`
counts uncached input for both providers. Anything not found stays unknown with a note.

`grampus report <task>` prints the scorecard: per-stage figures, totals, rounds, wall time and the
human cost (decisions, answers to worker questions, how many came from chat, and how long tasks waited
for them). For a running task it measures
now and is marked provisional. The dashboard shows the same scorecard.

**Estimated cost** (`measure/cost.ts`) prices each dispatch's tokens at API list prices: input,
cached input, cache writes and output (reasoning is inside output for both providers). Claude
transcripts name the model of every message, so usage is split per model; Codex reports session
totals, which split only when one model ran. A model without a price, or usage that cannot be split,
stays unknown with a note. Cost is computed when the scorecard is built, from the current
`modelPrices` (a dated built-in table that `config.json` overrides per model), so nothing
price-dependent is recorded in the log. **Planned:** exports.

## Comparisons

`grampus compare --recipes a,b[,c] [--mode full|shared] <request>` (or the dashboard) writes
`<data>/comparisons/<id>/events.jsonl` and opens an Orca terminal in the repository's main checkout
that runs `grampus drive-comparison <id>`. That driver (`compare/driver.ts`) is the only writer to the
comparison log; it never writes an entry's log, it queues commands for entries like any client.

1. **Entries.** One task per recipe, using the recipe snapshot taken when the comparison started.
   The first entry starts from the repository's default base; its base commit is recorded and every
   other entry's worktree is created from that exact commit (`worktree create --base-branch <sha>`),
   which `createTask` verifies. At most `comparisonConcurrency` entries run at once; an entry stops
   counting once it has finished or waits for acceptance. An entry created just before a crash is
   adopted on restart.
2. **Shared mode.** Only the first entry starts until the user approves its spec. The others then
   start with `spec.inherited`: the approved spec copied into their task folder, no spec stages and
   no approval gate. The spec phase's cost is counted in the first entry.
3. **Full mode.** Every entry runs the whole pipeline. When all have reached their result, the
   cross-check (`compare/cross-check.ts`) runs each entry's spec checks against every other entry's
   verified commit, in the candidate's worktree with the spec owner's added or changed test files
   overlaid, then restores those files and refuses to record a cell unless the worktree is clean.
4. **Pick.** The comparison asks the user to pick. `grampus pick <comparison> <task>` queues `accept`
   for the winner and `decline` for every other unfinished entry; a declined entry finishes as
   `not-selected`, measured like any other. `abandon <comparison>` abandons every entry. The driver
   finishes when every entry has.

The dashboard's comparison page shows the entries side by side (checks, review, how many of the other
specs' checks each result passed, rounds, time to result, agent time, tokens, estimated cost and the
user's decisions), bar charts of the same, and the cross-check matrix. `status` and `wait` include
comparisons, so a chat agent hears when a pick is needed.
