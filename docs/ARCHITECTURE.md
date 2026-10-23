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
  workers  ── spec, spec review, tests, build, review, repair, polish, explain, answer
             write files under <worktree>/.grampus/, commit on the task branch
```

`grampus new` creates the task folder and log, an Orca worktree (`worktree create --no-parent
--setup run`), and an Orca terminal in that worktree whose command is `grampus drive <task>` (by full
path; see [Installation](#installation)). The repository is `--repo`
or the current folder's, resolved through `git rev-parse --git-common-dir` to the main checkout, which
is how Orca knows repositories. Without `--title`, `agents/title.ts` asks `titleModel` (Claude Haiku
by default, through `claude -p` with the request on standard input, no tools, in a neutral folder) for a
short name, since the title also names the task id, worktree and branch; on any failure or after
`titleTimeoutMs` the request's first line is used. Comparisons are named the same way. The naming
call's tokens are not measured. Orca opens a first terminal in every new worktree; Grampus closes it
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
| `domain/` | `recipe.ts` | Recipe schema, the built-in standard recipes, family checks |
| | `explanation.ts` | Candidate-bound explanation, purpose groups and code references |
| | `spec.ts` | Spec parsing: one fenced `grampus` JSON block with checks and protected paths |
| | `review.ts` | Review reports and the blocking rule |
| | `events.ts` | The event log schema and user command schema |
| `orca/` | `client.ts`, `protocol.ts` | The Orca CLI client and the JSON it reads |
| `compare/` | `comparison.ts` | Comparison log, commands and fold |
| | `create.ts`, `driver.ts` | Starting a comparison; its driver: entries, shared spec, pick |
| | `cross-check.ts`, `status.ts` | Every spec against every result; comparison status text |
| `agents/` | `catalog.ts` | Models and effort levels per agent, read from the Claude and Codex CLIs |
| | `title.ts` | Naming a task from its request with a small Claude model |
| `git/` | `git.ts` | Git queries, and the reset that discards a polish pass |
| `measure/` | `transcripts.ts` | Reading models, effort and tokens (per model) from Claude and Codex transcripts |
| | `cost.ts` | Estimated cost at API list prices, with the dated built-in price table |
| | `usage.ts` | Per-dispatch measurements, splitting continued conversations by request time |
| | `report.ts` | The scorecard: per-stage figures, totals and human cost |
| `checks/` | `run-checks.ts` | Running check commands with logs, timeouts and one flaky rerun |
| `store/` | `task-store.ts` | Task folders, `events.jsonl`, `commands.jsonl` |
| | `driver-lock.ts` | The driver lock, its heartbeat, and whether a driver went missing |
| `dashboard/` | `server.ts`, `http.ts` | `grampus dashboard`: static web app, JSON API, request guards |
| | `api.ts` | API routes |
| | `actions.ts` | Starting, merging and removing tasks, Orca tabs, recipe edits and the model catalog |
| | `views.ts`, `timeline.ts`, `types.ts` | Task views built from the fold, and the JSON contract the web app imports |
| | `tasks.ts` | Cached log reads and the change watcher behind live updates |
| `web/` | `app/` | The dashboard: Vue 3, Nuxt UI, built into `dist/web` |
| `pipeline/` | `driver.ts` | Driver entry point and lock |
| | `change-review.ts` | Optional read-only explanation and follow-up workers |
| | `driver-core.ts` | Recording, request ids, inbox pump, commands, decisions, running a stage |
| | `pipeline.ts` | Stage order: run, gate, spec, tests first, baseline, rounds, finish |
| | `spec-phase.ts` | Spec writing, automatic correction, checks on the original commit, spec review, approval |
| | `polish.ts` | The optional polish pass after a ready round |
| | `guard.ts` | The deterministic integrity guard |
| | `prompts.ts` | Worker task specs |
| | `state.ts`, `status.ts` | The fold from events to state, and summaries |
| | `create-task.ts` | `grampus new` |
| | `remove-task.ts` | `grampus remove` |

## Pipeline

Before any spec or baseline checks, the driver prepares the worktree. `setup.configured` snapshots
`grampus.json` from the base commit, or the conventional root lockfile command. `setup.started` is
recorded before execution and `setup.recorded` stores its result and log separately from checks.
A successful setup is not repeated on restart. A failed or interrupted attempt requires an explicit
retry; an uncertain attempt is never silently replayed. Setup must leave HEAD and tracked files
unchanged. See [repository setup](CONFIGURATION.md#repository-setup).

Fresh clean checkouts first normalise Git's implicit CRLF conversion back to the
committed LF form, respecting explicit CRLF attributes and leaving shared Git
configuration alone. This happens before workers and baseline checks.

An optional base-commit `behaviouralHarness` adds the same portable commands,
public-interface contract and protected test/helper files to every approved spec.
Cross-check overlays exclude these files and reject a candidate that changed them.
Named assertion failures are retained alongside command-level compatibility and
execution classifications, so mixed output cannot hide an assertion that ran.
These observations are shown in CLI comparison status and the dashboard; they do
not turn unknown test compatibility into a behavioural verdict.

Implementation reviews must declare executable probes. Their source is retained
in the report; missing committed regressions request bounded coverage repair.
Probe requirements carry across reviews until a named committed regression is
reported. The driver verifies the file and named text at the candidate commit;
the reviewer verifies assertion meaning and inclusion in approved checks.

The same configuration snapshot includes mandatory repository verification: explicit `checks` in
`grampus.json`, or the root Node `verify`/`check` script. These checks are merged ahead of acceptance
checks into the exact spec bytes before approval, so baseline, build, repair and polish all use the
same commands. Recipes cannot narrow the baseline. `pipeline/repository-config.ts` owns discovery;
repositories without an explicit or conventional gate remain explicitly without an inferred baseline.


1. **Run and gate.** The driver creates its Run and an approval gate on a placeholder Orca task, so
   the pending decision is visible in Orca.
2. **Spec** (`spec:<n>`). A worker writes `<worktree>/.grampus/spec-<n>/spec.md`. Grampus parses it;
   an unusable file is sent back once (`specLimits.automaticCorrections`) with the error, then the user
   decides. Valid specs become versions, copied to `<task>/spec/v<version>.md`. Revisions and
   corrections try to continue the previous spec conversation (see reuse below) and always list the
   questions the user already answered, so a fresh writer does not ask them again.
   The machine-readable block requires an `acceptance` mapping with unique ids. Each entry names a
   requested outcome, executable scenario, declared checks, real components, mocked components and
   known limitations. The mapping is proportional to the task: direct function tests can suffice for
   a function change; a requested journey must cover its relevant production boundaries.
3. **Checks on the original commit.** As soon as a spec version is recorded, the driver runs its checks
   at HEAD, without reruns, alongside the approval request (`checks.recorded`, phase `spec`). The
   results are added when they land, with a fresh request. A check that fails here for any reason
   other than the missing behaviour (no tests ran, a missing tool) can never pass, so the user and the
   spec reviewer see it before anything is built. After an approval the checks finish before the
   build, since they become the baseline; after a revision they are stopped and not recorded.
4. **Spec review** (`spec-review:<version>`, optional). Starts when the checks on the original commit
   have landed, with their results and the log tails of failing ones, and runs alongside the approval
   request, so the user sees the spec without waiting for it. Its findings are added when it lands,
   with a fresh request (which wakes `grampus wait`) carrying its findings. A review still running when
   the user decides is stopped (`stage.stopped`) and recorded as such. The dashboard asks for
   confirmation before approving while the checks or the review are still running.
5. **Approval.** `approve` must name the latest version. `status` and `wait` print the spec text, its
   checks on the original commit (with the last log lines of failing ones) and its review with the
   request, and every accept or escalation request prints the round's evidence
   (commits, changed files, checks, integrity problems, review findings, reasons), so a chat agent can
   show it before asking. The gate is resolved and the approved spec is
   written to `<worktree>/.grampus/spec.md` for later workers.
6. **Tests first** (`tests:0`, optional). Both added and modified files matching `testFilePatterns`
   become protected. Test helpers in those paths count too. Production edits, deletions, renames and
   check-configuration edits stop the driver. A failed worker or no test changes asks whether to
   continue without tests. The reviewer sees the complete task diff, the current round's diff and
   the list of tests committed before implementation; tests do not disappear from the evidence when
   the builder leaves them unchanged.
7. **Baseline.** Reuse the checks on the original commit if HEAD has not moved; otherwise run checks
   at the tests-first commit without reruns. The test writer reports the check, changed test file,
   exact test name, criterion and assertion output in `tests:0/report.json`. `tests.baseline` reads the
   full independently captured log, rather than its display tail. Behavioural attribution requires a
   recognised assertion in the same named failure section as the claimed test and file. Node TAP,
   Vitest, Jest, pytest and matching named failure formats are recognised conservatively; unsupported
   output remains unknown. Missing prerequisites and incompatible tests take precedence over matching
   assertions. Arbitrary printed text cannot establish a red phase. The report is copied into task
   evidence, and incomplete or unproven red phases are shown at acceptance. A matched explanation is
   still attributed to the writer; the code reviewer must confirm causation and coverage.
8. **Rounds.** Round 0 is `build:0`; round `r` is `repair:<r>`. Repair rounds up to
   `recipe.repair.reuseBuilderRounds` try to continue the previous editor's conversation when the
   assignment is unchanged; later rounds start a fresh worker with the distilled problems.

   **Reuse.** Continuing a conversation passes the settled worker's handle to `worker-start --terminal`.
   Only terminal-mode workers accept a second dispatch. Workers started in Orca's Chat UI mode are
   structured workers, which Orca refuses (`terminal_unsupported_for_agent_session`, nothing applied).
   Grampus then records `stage.reuse_refused`, starts a fresh worker, and stops trying for the rest of
   the task.
9. **Verify.** The guard compares the round's start commit with HEAD: uncommitted or untracked files,
   no new commit, rewritten history, protected paths changed, test files deleted or renamed out of the
   test patterns. Modified tests are listed for the reviewer, and so is check configuration: files
   that decide how checks run (`checkConfigPatterns`, such as `Directory.Build.props`, a test
   project's `.csproj` or `package.json`, plus any file a check command names), whether changed,
   added or deleted, and even inside a test folder. Then every check runs at HEAD; a failing check runs once more and a pass is
   recorded as flaky.
10. **Review** (`review:<r>`, optional). The reviewer sees the whole change since the build started,
   the check results, the tests and check configuration modified in any round so far, and the previous
   round's blocking findings. A check configuration change that makes a check pass without the
   behaviour is blocking. Only findings with a file, a line and a scenario block; others are kept as
   downgraded notes.
   Both spec and implementation reviewers receive the original request and must assess its coverage.
   Implementation reviews must name every approved acceptance id exactly once, with verified or
   unverified status, concrete evidence and limitations. A missing mapping makes the review unavailable;
   gaps, unknown request coverage and unverified outcomes prevent readiness. An
   overlooked requested outcome cannot be dismissed merely because the spec omitted it. Coverage is
   an attributed review assessment, not a deterministic proof of the natural-language request.
11. **Decision.** Ready when there are no guard violations, failing checks or blocking findings. The
    request to the user names any check configuration changed since the build started. A
    builder that reported failure or an unavailable or unknown review escalates immediately. Coverage
    problems can drive automatic repair only when the review requests changes, request coverage is
    known and a supported blocking finding gives a file, line and failing scenario. Otherwise they
    escalate immediately. `recipe.repair.coverageGapRounds` bounds these automatic repairs separately
    from the ordinary `maxRounds` allowance; a round with both kinds of problem consumes the coverage
    allowance. The built-in recipes allow three coverage repairs and two ordinary repairs. Saved
    recipes that omit the coverage allowance use zero. Counts derive from recorded automatic
    decisions and their reviews, so restarts do not reset them. Exhausting either allowance escalates.
    Manual continuation grants one attempt without replenishing automatic allowances. Repairs receive
    the original request, full coverage problems and supported findings; they must test the real
    failing journey and may fix omitted requested behaviour without changing the approved spec.
    The dashboard pipeline strip shows the current round without treating either allowance as a
    total round limit.
12. **Polish** (`polish:<r>`, optional, once per ready round). One worker improves readability,
    maintainability, consistency, simplicity and naming while preserving behaviour. Standalone naming
    and consistency improvements are allowed and assessed on their benefit, with no requirement to
    justify a hypothetical future edit. The worker follows repository conventions and avoids changes
    made solely for personal preference. Finding no useful improvement is a successful no-op.
    Extraction must consolidate the same rule or responsibility, not merely similar-looking code.
    Up to `polishLimits.adjacentFiles` adjacent files may be changed to complete a specific improvement;
    each needs a recorded explanation. Broader cleanup is outside this stage. Protected acceptance
    tests stay protected, and other tests may only be adapted without weakening cases or assertions.
    Check configuration must not change.

    The worker writes a bounded structured report with the problem identified before editing, concrete
    benefits and affected files. Polish and polish-review reports live under
    `<worktree git directory>/grampus/<stage>/report.json`, outside the source tree, and are copied into
    the task evidence store. Git cannot add them to the product commit, even with force-add. A clean
    unchanged commit and an empty improvement list is a successful `noop`, not a rejection. Otherwise
    Grampus guards and checks the new commit, and an independent reviewer assesses both behavioural
    safety and maintenance value. Retention requires an approving review and `worth-keeping`
    maintenance verdict. Missing evidence, uncertainty, insufficient benefit, failed checks or scope
    violations discard the pass. A recipe without a reviewer cannot retain polish edits.

    `polish.decided` records `kept`, `noop` or `discarded`, the report, maintenance assessment, original
    verified commit, attempted commit and before/after diff sizes. Line counts are context, not a
    success criterion. The decision is recorded before resetting a discarded pass; restart completes
    an interrupted reset. `polish.restored` records completion so a later restart cannot reset subsequent
    rounds. There is no repair loop and no extra human gate. The verified implementation remains
    the fallback. A subsequent user-requested implementation round may receive its own polish pass.
13. **The user** accepts (recorded as an override after escalation), continues with guidance (one more
    round) or abandons. Every repair prompt carries all the guidance given so far, oldest first, so an
    automatic round after a continue still follows it. Finishing releases every worker: settled ones with `worker-release`, unsettled
    ones with `worker-stop`. When every check already passed at the baseline, the acceptance request
    says so: those checks show no regression but do not demonstrate the new behaviour.

Change understanding runs as optional evidence after verification and any kept polish. A recipe
may enable automatic generation; otherwise the user requests it at the acceptance point. An optional
worker reads the request, approved spec, relevant architecture and complete Git diff, then writes a
validated explanation with purpose groups and candidate line references. Follow-up questions use a
separate optional worker. `explanation.recorded` and `answer.recorded` bind results and failures to the
base SHA, candidate SHA and spec version. Report failures do not alter correctness or acceptance.
Automatic explanations run while the acceptance decision is available. Accepting or continuing stops
an unfinished explanation before the pipeline proceeds. Reviews run serially, including across inbox
pumps, so follow-ups can only consume a recorded explanation. Purpose-group ids must be unique and
line references must resolve to existing lines, including rejecting line one of an empty file. A report
is usable only after its evidence file is stored successfully. The driver requires a clean candidate
before launching a review. Pre-existing uncommitted work makes the explanation unavailable while
leaving repair available. After a review starts, an unexpected edit, even by a failed worker, stops the
driver until the recorded candidate is restored; it cannot inherit earlier verification. The driver
records their stages, request ids and measurements. A completed task's driver has closed; queued review
commands launch a short-lived `drive-review` in its worktree under the same lock, rebind its Orca Run,
and close the tab after success. An interrupted review records its stop and leaves its terminal open;
`drive-review` resumes the existing dispatch. Replies to live review-worker questions remain available
after task completion. Previous explanations remain in the event log after repairs.

The Changes view drops superseded API responses and checks diff commit bindings before displaying
selectable lines. Single-file diffs retain both rename endpoints and treat filenames as literal paths.
Opening an earlier explanation's reference reports its stale binding rather than highlighting those
line numbers in the current candidate or changing the binding of already selected feedback.
Submitting feedback rejects empty requests and removes only the unchanged requests that were sent;
requests added or edited while the submission is in flight remain as drafts.

## Dashboard

`grampus dashboard [--port <n>]` serves the built web app (`dist/web`) and a JSON API from one Node
process, on port 4545 and every interface by default, so a phone on the same network can use it. It
prints the addresses it answers on.

- **Reads** come from the same fold the driver uses (`TaskReader` caches folds by log size). Views add the
  pipeline strip, spec versions with their text and review, worker messages with their answers, rounds
  with guard, checks, review and polish pass, queued commands and a plain-language timeline.
- **Writes** queue commands with source `dashboard`, exactly like the CLI; the driver stays the only
  writer to its Run and log. The few actions the CLI takes outside a driver are offered too: starting
  a task (`grampus new`, with Orca's repositories and recent ones to pick from), `grampus merge`,
  `grampus remove` (its dialog sends `--force`, having said what that discards), and
  bringing the driver terminal or the changed files forward in Orca (`terminal switch`,
  `file open-changed`), which acts on the Orca window of the machine running Grampus, and resuming a
  stopped driver.
- **Resume** (`POST /api/tasks/<id>/resume`, `/api/comparisons/<id>/resume`) does what rerunning
  `grampus drive` does: it opens a new Orca tab where the driver ran (the task worktree, or the
  repository's main checkout for a comparison) running `drive` or `drive-comparison`. It is refused
  unless the driver stopped or went missing and the task is unfinished, and again for `driverStaleMs`
  after a resume, so a second click does not open a second tab before the new driver records its start;
  the driver lock refuses a second driver anyway. The old tab is closed only if its pane still carries
  the title Grampus gave it (`terminal show` reports `paneTitle`; the shell overwrites the tab title),
  so a driver someone ran in their own terminal leaves that terminal open. A driver records its
  terminal in `driver.started`, and the fold takes it as the driver terminal from then on.
- **Recipes** can be created, copied, edited and deleted. They are written to `config.json` (other
  settings kept), validated with the same rules as at startup, and replaced in one rename. The model
  and effort lists come from `codex debug models` (a JSON catalog) and from `claude --help` (aliases
  and effort levels) plus Claude models seen in recipes and measurements; any model can be typed.
- **Live updates**: `/api/live` is a server-sent event stream. A watcher polls log and queue sizes every
  `waitPollMs` and sends the ids of tasks that changed; after a reconnect the page reloads everything.
- **Files**: only paths a task's log records (spec versions, check logs) can be fetched.
- **Changes**: `/api/tasks/<id>/changes` counts lines per file between the task base or a recorded prior
  candidate (`from`) and the current commit. `/api/tasks/<id>/diff?path=...` returns one complete changed
  file diff at a time. The legacy whole-diff response is capped by `dashboardDiffBytes` and identifies
  truncation. Uncommitted work is excluded. Overview and Changes share a collapsible folder tree with
  per-file line counts. The Changes tab keeps that tree beside the selected file diff when its panel
  has room, with all files accessible, code-linked explanation and answers, and editable guidance through
  `continue` command. The explanation opens by default with a summary, labelled before/after comparison,
  file-linked key changes and caveats. It sits beside the diff when the content area has enough room,
  and stacks above it on smaller screens. Notes in Overview, Spec and explanations render in full;
  rationale and validation sit under More detail. Key changes provide the purpose navigation without
  a duplicate Purposes control. Unlabelled comparisons remain intact rather than guessing a split. The explanation
  worker targets 250 words, with a 25-word summary, 35 words per comparison side and short purpose groups;
  these are writing targets, not rejection limits, and material caveats take priority. Follow-up answers
  target 120 words unless more detail is requested. The report schema and candidate binding are unchanged.
  Review markers and an editable PR draft are stored in this browser per candidate;
  they do not gate acceptance or publish anything.
- **No login.** Anyone who can reach the port can control tasks. The guards stop other web pages from
  using a visitor's browser: requests must name one of this machine's host names or addresses (or
  `dashboardAllowedHosts`), so DNS rebinding fails; writes must carry the dashboard's own `Origin` and a
  JSON body, so cross-site forms and fetches fail; pages cannot be framed; a strict Content Security
  Policy and Markdown rendered without raw HTML contain agent output.
- Icons are bundled at build time, so the dashboard works without internet access.
- Task pages show conclusions before supporting prose. Checks and review keep the latest round open,
  show check and review status separately, and collapse earlier rounds and baseline evidence. Review
  coverage lists unverified outcomes first and keeps them expanded; verified evidence is opened per
  outcome. Repeated caveats share one entry with all affected ids, and caveat counts remain visible.
  Blocking findings stay open. The Spec overview uses recorded acceptance scenarios without rewriting
  their conditions; the complete specification remains available and is still what approval binds.
  Worker prompts request concise outcomes, labels and review summaries while preserving necessary
  conditions and evidence. These writing targets do not change report validation or event schemas.
  Questions needing answers come first; answered and closed threads collapse. Overview keeps active
  or failed workers and pending or refused commands visible, with completed history on demand.
  Timeline defaults to milestones plus all warnings and errors, with an all-activity switch. Scorecard
  breakdowns collapse beneath totals and unknown-usage notices. Events remain searchable across the
  entire log while displaying 50 matches at a time.
- **Pages**: a navigation rail that widens over the page on hover or focus, and a task list (needs you
  first) beside the selected task. The task header holds its title, repository and base commit, the
  pipeline strip (wrapping when narrow) and tabs for overview, spec versions with review, checks and
  review per round (with check logs), worker questions and answers, timeline, scorecard and the raw
  event log. The overview shows the pending decision (its evidence behind Show details), the request,
  the spec's Outcome section as the description and your decisions, beside the workers and the files
  changed with a link to the Changes tab. The open tab is part of the address, so it can be bookmarked.
- **System** (`dashboard/health.ts`, `/api/health`): every unfinished task's and comparison's driver
  (alive by its lock heartbeat, starting, or stopped with why; the build it runs from `driver.started`;
  whether Orca is turning it away as busy), the workers that have not reported (working, asking, quiet
  for `stalledWorkerMs`, or exited), Orca from `orca status`, each agent provider's sign-in state and
  usage limits from `orca account list`, and the `orca.busy`, `orca.room`, `orca.uncertain` and
  `driver.stopped` events of the last `healthHistoryMs`. Problems come first, each with an id that stays
  the same while it lasts: a stopped driver, an Orca that does not answer, an unavailable provider a
  recipe uses, or a usage limit reached are errors; Orca busy, a driver or the dashboard on an older
  build than the installed one, a quiet or exited worker, and a limit at `providerUsageWarnPercent` are
  warnings. Orca is checked at most every `healthProbeMs` (each check runs its CLI, with a
  `healthProbeTimeoutMs` deadline); the page asks again on that interval and whenever a log changes. A
  stopped driver has the same Resume action as its task or comparison page.
- **Attention**: the tab title counts tasks that need the user and the favicon gets a dot, also while
  the system has an error. The System item in the rail shows the number of problems in the colour of the
  worst. Desktop notifications announce each new decision, question and system error, where the browser
  allows them (localhost or HTTPS, so not on a phone over plain HTTP). A web app manifest lets it be
  added to a home screen.

## Durability and recovery

- Every Orca mutation's request id is recorded (`orca.requested`) before the call and passed as
  `--retry-request`. Orca replays a repeated id with the original receipt, so after a crash or an
  uncertain result the driver simply repeats the call.
- An uncertain result is a timeout, output without a JSON envelope, or one of the codes Orca's own CLI
  treats as an unknown outcome (`runtime_unavailable`, `remote_runtime_unavailable`, `runtime_timeout`,
  `invalid_runtime_response`); any other error envelope is a refusal. The driver repeats an uncertain
  call up to `orcaRetries` times, waiting longer each time, so a restarting Orca does not stop it; each
  repeat is recorded (`orca.uncertain`) for the System page. A repeated inbox `check` leaves out its acknowledgement, as a restarted driver does. A call that stays
  uncertain stops the driver (`driver.stopped`); running `grampus drive <task>` again resumes.
- `runtime_busy` (Orca's long-poll slots are full; see [Orca contract](#orca-contract)) means Orca
  applied nothing, so a busy call never counts towards `orcaRetries`. A busy mutation (such as
  `worker-start`) is repeated with the same request id every `orcaRetryDelayMs` for as long as Orca
  stays busy; user commands wait until it goes through. A busy inbox `check` is likewise not counted:
  the driver waits `orcaRetryDelayMs` and checks again on its next pump, applying user commands in
  between. A comparison with more running entries than Orca's long-poll limit keeps Orca busy, so
  this waiting is routine there rather than a fault. Each busy spell is recorded once, when it starts
  (`orca.busy`) and when Orca takes the call (`orca.room`, with how long it waited), not per refusal.
- The inbox is acknowledged only on the next `check` after every message is recorded. Replayed
  messages are skipped by id.
- A reply Orca refuses (say its worker has gone) is recorded as `command.refused` and the question
  stays open, instead of stopping the driver on every restart.
- A question closes when the dispatch that asked it settles, exits or is stopped, as Orca's does. It
  no longer counts as waiting for the user, and the driver refuses a reply to it without calling Orca.
  A driver that restarts after a worker went on with its default records the question already closed.
- A settled worker is retained before its message is acknowledged and released when the task finishes.
- A worker is treated as gone only on Orca's positive `exited` liveness verdict. Start failures and
  exits wait for the user (`retry` or `abandon`); `retry` stops an `outcome_unknown` start first and
  passes `--retry-of`.
- A worker the pipeline waits on that has not reported, asked or been answered for `stalledWorkerMs`
  raises `stage-quiet:<stage>:<attempt>` (`retry` or `abandon`) while it keeps running; Orca's
  liveness cannot tell a worker stuck at a prompt from a busy one. `retry` stops it and starts a fresh
  worker with `--retry-of`. If the worker reports, asks or ends first, the request is withdrawn
  (`attention.withdrawn`). A worker waiting for the user's answer is never quiet. Workers that run
  alongside a decision (the spec review) are not watched.
- Decisions are keyed (`approve-spec:2`, `ready:1`, `escalate:0`, `stage-failed:build:0:1`), so a
  restarted driver finds a decision already made instead of asking again.
- A polish pass resumes at its first unrecorded step: its worker and review are stages, its checks
  are `polish.checked`, and a discarded pass whose reset did not happen is reset on restart.
- A driver started in a different terminal rebinds the Run with `run-use`.
- `driver.lock` in the task folder holds the driver's process id and a random token, and the driver
  touches it every `driverHeartbeatMs`. A second driver is refused while the owner's process runs and
  its heartbeat is fresh; a lock whose process ended, or whose heartbeat is older than `driverStaleMs`,
  is taken over (Windows reuses process ids). The driver checks its token before every write, so a
  driver whose lock was taken over stops without writing, not even `driver.stopped`. Comparison drivers
  use the same lock.
- A driver that ends without recording why (killed, its tab closed, the machine restarted) is shown as
  stopped by `status`, `wait` and the dashboard once its heartbeat is `driverStaleMs` old, or, without
  a lock, `driverStaleMs` after the task was created. The time it is reported from does not move, so
  `wait --after` reports it once. Nothing restarts drivers automatically; the dashboard's Resume
  driver button or `grampus drive` does.
- Log and command files are JSON Lines appended one record per write. A crash can tear only the line
  being written; it never parses, so readers skip it and the next append starts a fresh line.

## Files

```text
<data>/config.json                       optional settings
<data>/tasks/<task>/events.jsonl          append-only event log (schema 6)
<data>/tasks/<task>/commands.jsonl        queued user commands
<data>/tasks/<task>/driver.lock          the running driver's process id, token and heartbeat
<data>/tasks/<task>/spec/v<n>.md          spec versions and their reviews
<data>/tasks/<task>/reviews/round-<r>.json
<data>/tasks/<task>/reviews/polish-<r>.json
<data>/tasks/<task>/explanations/<command-id>.json
<data>/tasks/<task>/checks/<phase>-<r>/   check logs
<data>/comparisons/<id>/events.jsonl      comparison log (schema 4)
<data>/comparisons/<id>/commands.jsonl    queued picks and abandons
<data>/comparisons/<id>/driver.lock      the comparison driver's lock, as for a task
<data>/comparisons/<id>/cross-check/      cross-check logs
<worktree>/.grampus/                      files exchanged with workers (excluded from Git)
```

The data directory is `GRAMPUS_HOME`, or on Windows `%LOCALAPPDATA%\Grampus\orca` for an installed
build and `%LOCALAPPDATA%\Grampus\orca-dev` for a checkout. `.grampus/` is
excluded through the repository's `info/exclude`. Workers author commits. Grampus fast-forwards shared
acceptance tests, restores discarded polish passes, and delivers accepted changes with `grampus merge`
(below). `grampus remove --worktree` asks Orca to remove a
worktree, and Orca deletes its branch only when it can tell the branch is merged.

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

## Removal

`grampus remove <task> [--worktree] [--force]` (`pipeline/remove-task.ts`, also the dashboard's Remove
task) deletes the task folder: its log, specs, reviews, check logs and scorecard. Nothing is archived.
It takes the task's driver lock first, so it is refused while a driver runs and no driver can start
while the task goes. It refuses comparison entries, and unfinished tasks unless `--force`, which is
meant for a task whose driver can no longer run: Grampus never calls orchestration outside a driver,
so that task's workers are not stopped. With `--worktree` it closes the driver tab and runs `orca
worktree rm` (with `--force` when given, which discards uncommitted changes) before touching the
folder: a refusal or an unknown outcome leaves the task in place, and a repeat that finds the worktree
gone carries on. `events.jsonl` is deleted before the rest, so an interrupted removal never leaves a
half-listed task. The task's Orca Run stays, since Orca cannot delete one Run. **Planned:** removing a
comparison with its entries.

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
- `worktree rm --worktree id:<id>` refuses a worktree with uncommitted or untracked files
  (`runtime_error`; ignored files such as `.grampus/` do not count) unless `--force`, answers
  `selector_not_found` for an unknown id, and keeps the branch unless it can tell it is merged. It
  answers `removing: true` and finishes deleting the folder a few seconds later.
- Orca admits 16 long-polls at once (at most half of them `ask`). `check --wait`, `worker-start`,
  `ask`, `terminal wait` and agent launches count; every running driver holds a `check --wait` most of
  the time. Past the limit Orca answers `runtime_busy` ("long-poll capacity reached; retry with
  backoff") before running the call. Its CLI treats `runtime_unavailable`,
  `remote_runtime_unavailable`, `runtime_timeout` and `invalid_runtime_response` as unknown outcomes.
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
2. **Shared mode.** The first entry writes the spec. If its recipe enables tests first, the others
   also wait for its test commit and baseline evidence. They inherit the same approved spec and
   acceptance-test SHA, fast-forward their clean base worktrees to that immutable test commit and
   protect the same files. They do not run their own spec or tests-first workers. The test commit is
   checked for changes outside its recorded test files before application, and a restart at that SHA
   records completion without repeating the fast-forward. When the first recipe has no tests-first
   stage, all entries start with the existing tests at the common base. Spec and test-authoring cost
   belongs to the first entry; compare implementation phases separately.
3. **Full mode.** Every entry runs the whole pipeline. When all have reached their result, the
   cross-check (`compare/cross-check.ts`) runs each entry's spec checks against every other entry's
   verified commit, in the candidate's worktree with the spec owner's added or changed test files
   overlaid, then restores those files and refuses to record a cell unless the worktree is clean. It
   runs one cell per driver pass (`cross_check.started`, then `cross_check.cell` for each), so commands
   still apply, `status` and the dashboard show progress, and a restarted driver skips measured cells;
   `cross_check.recorded` marks it complete. Each check has an assessment: passed, behavioural failure, incompatible, execution error or
   unknown. A failing copied test counts as behavioural evidence only when its approved check declares
   `portable: true` and its log contains a recognised assertion failure. Missing prerequisites and API
   errors take precedence. Otherwise compatibility remains unknown, even when execution reaches an
   assertion. Cell totals include execution errors rather than dropping them from the denominator.
4. **Pick.** The comparison asks the user to pick once every entry has its result and the cross-check
   is in. A pick sent before that is refused, never held until then. `grampus pick <comparison> <task>`
   queues `accept` for the winner and `decline` for every other unfinished entry; a declined entry
   finishes as `not-selected`, measured like any other. `abandon <comparison>` abandons every entry at
   any time. The driver finishes when every entry has. The dashboard offers "Keep this one" only while
   the comparison asks, on the comparison page, and asks for confirmation before keeping an entry
   that did not pass everything.

The dashboard's comparison page shows the entries side by side (checks, review, how many of the other
specs' checks each result passed, rounds, time to result, agent time, tokens, estimated cost and the
user's decisions), bar charts of the same, and the cross-check matrix, filling in while it runs. `status` and `wait` include
comparisons, so a chat agent hears when a pick is needed.

Cells bind both the candidate commit and the test-source commit to their spec versions and hashes.
Continuing, revising or retrying an entry withdraws the pick request and invalidates affected rows and
columns, including a later result at the same SHA. The driver records `evidence.invalidated`, retains
unaffected cells and resumes the missing cells across restarts. Each execution gets its own log directory
so refreshed checks cannot overwrite earlier evidence. A cell completed during an entry change is
revalidated on the next driver pass before it can authorise a pick.

CLI and dashboard project freshness from current entry logs and pending mutation commands, even
before the comparison driver notices or when it has stopped. They hide the old pick and stale cells,
show the refresh notice and suppress obsolete cross-check totals. Pick commands name the request they
were made against; an old dashboard choice is refused even after a fresh pick request has appeared.
Shared comparisons apply the same decision invalidation without running a cross-check. Completed
comparisons retain their historical evidence. Status says how many entries passed their own checks
with review approved; incompatible, unmeasured and behavioural cross-check outcomes remain separate.

The code-review prompt explicitly requires reconciling shared-code changes with requirements to keep
other behaviour unchanged, citing preservation evidence. Demonstrated contradictions are findings;
missing evidence stays unverified. This changes the measured reviewer contract without adding a stage.


## Final candidate and experiment evidence

`pipeline/candidate.ts` is the common resolver for commit, spec version, checks, guard and review.
A retained polish uses its checked commit and evidence, including on the comparison diagonal.
Status, comparison, acceptance, delivery, explanation validation and scorecards resolve that same
candidate. Acceptance refuses a moved or dirty worktree; delivery verifies that the accepted SHA
matches the recorded candidate. Failed checks remain failures even when a candidate exists.
Checks, guard, review, round decisions and polish explicitly record their spec version. The resolver
refuses mixed commit/spec evidence, incomplete command lists and a superseded round while a new builder
works. Checks and read-only reviews are surrounded by commit, tracked-tree and approved-spec checks;
unexpected changes stop the driver instead of attaching evidence to the wrong inputs. Waiting for
acceptance also checks the candidate. A retained polish preserves outcome coverage through its
independent behaviour-preservation review, while keeping the original review in the log.
Comparison entries defer the idle worktree check because cross-checks temporarily overlay tests;
final acceptance still requires the restored, clean candidate and matching approved specification.

Scorecards separate setup, specification, tests, implementation, repair, polish, verification and
explanation. Check duration includes both attempts when a failed check is rerun. Phase time sums
work and is not elapsed wall time. Missing agent time and cost remain unknown; partial totals name
missing measurements. Human waiting is separate. Interventions carry an optional explicit
`purpose` of `implementation` or `workflow`; setup and worker-failure gates identify workflow
interventions automatically. Unclassified interventions stay unknown, without guessing from prose.

For a controlled polish experiment, use each pass's recorded `fromSha` as the unpolished control
and its attempted SHA as treatment. The same implementation and spec are used for both. Compare
its maintenance assessment, incremental polish and review cost, check time and retained/no-op/rejected
outcome. Comparing independently generated recipes with and without polish does not isolate polish.
For builder comparisons, use shared mode with tests first in the first recipe, target stable public
interfaces, and compare repeated runs over several tasks. Full mode includes spec quality and test
compatibility differences and is not an interchangeable behavioural benchmark.

Task schema 6 and comparison schema 4 describe this workflow. Earlier logs are refused, not migrated
or rewritten. Recipe configuration now uses `polish`; `simplify` is not a supported alias.
