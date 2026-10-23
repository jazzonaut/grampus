# Configuration

Grampus reads `<data directory>/config.json` when it exists. Every field is optional; an invalid file
is refused rather than ignored. The data directory is `--home <dir>` for one command, or
`GRAMPUS_HOME`, or on Windows `%LOCALAPPDATA%\Grampus\orca` for installed Grampus and
`%LOCALAPPDATA%\Grampus\orca-dev` when run from a checkout. The installer reads `keptVersions` from
the installed data directory.

| Setting | Default | Meaning |
| --- | --- | --- |
| `orcaCommand` | `["orca"]` (or `ORCA_CLI_COMMAND`) | The Orca CLI and any leading arguments |
| `orcaCallTimeoutMs` | `600000` | Deadline for one Orca call; `worker-start` waits for setup and readiness |
| `gitTimeoutMs` | `60000` | Deadline for one Git query |
| `inboxWaitMs` | `5000` | How long the driver blocks on Orca's inbox before reading local commands |
| `livenessIntervalMs` | `60000` | Minimum interval between liveness checks of unreported workers |
| `orcaRetries` | `3` | How many times the driver repeats an Orca call whose outcome is unknown (Orca unreachable, timed out, no answer) before it stops. A busy Orca (`runtime_busy`) does not count: that call is repeated until Orca has room |
| `orcaRetryDelayMs` | `5000` | Wait before the first repeat; each later repeat waits that much longer. Also the wait between repeats of any call while Orca is busy |
| `driverHeartbeatMs` | `10000` | How often a running driver touches its `driver.lock`, so others can tell it is alive |
| `driverStaleMs` | `60000` | A driver whose lock has not been touched for this long counts as gone: `status`, `wait` and the dashboard show it as stopped, and a new driver may take over. At least three heartbeats |
| `stalledWorkerMs` | `3600000` (1 hour) | How long a worker the pipeline waits on may go without reporting, asking or being answered before the user is asked whether to retry it |
| `waitTimeoutSeconds` | `540` | How long `grampus wait` blocks before reporting nothing new |
| `waitPollMs` | `2000` | How often `grampus wait`, the dashboard and comparison drivers reread logs |
| `defaultCheckTimeoutSeconds` | `900` | Check timeout when the spec sets none (at most 3600) |
| `checkShell` | `null` | Shell for check commands; null uses cmd.exe on Windows and /bin/sh elsewhere |
| `testFilePatterns` | `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**` | Paths the guard treats as tests |
| `checkConfigPatterns` | `**/grampus.json`, `**/Directory.Build.props`, `**/Directory.Build.targets`, `**/*Tests.csproj`, `**/*Test.csproj`, `**/test/**/*.csproj`, `**/tests/**/*.csproj`, `**/*.runsettings`, `**/testconfig.json`, `**/global.json`, `**/package.json`, `**/tsconfig*.json`, `**/vitest.config.*`, `**/vitest.workspace.*`, `**/jest.config.*`, `**/playwright.config.*`, `**/eslint.config.*`, `**/.eslintrc*`, `**/eslint-suppressions.json`, `**/pyproject.toml`, `**/pytest.ini`, `**/setup.cfg`, `**/tox.ini`, `**/conftest.py`, `**/Makefile` | Paths outside the tests that configure how checks run; the guard names changes to them, and to files a check command names, for the reviewer and the user |
| `crossCheckIncompatiblePatterns` | C# and TypeScript compiler errors, missing modules and exports, Python import errors, Java `cannot find symbol`, Rust `error[E…]` | Regular expressions that mark a failed cross-check as incompatible: the copied tests did not compile or load against that entry |
| `checkInfrastructurePatterns` | Missing command/module, no-tests and `ENOENT` signatures | Case-insensitive regular expressions for execution failures; these never count as behaviour evidence |
| `checkAssertionPatterns` | `AssertionError`, `ERR_ASSERTION`, expected/received and `Assert.` signatures | Recognised assertions; cross-check behavioural attribution additionally requires a portable check |
| `recipes` | `[]` | Saved recipes beside the built-in `standard-codex` and `standard-claude` recipes |
| `claudeProjectRoots` | `["<CLAUDE_CONFIG_DIR or ~/.claude>/projects"]` | Where Claude session transcripts are searched for measurement |
| `codexSessionRoots` | `["<CODEX_HOME or ~/.codex>/sessions"]` | Where Codex rollouts are searched for measurement |
| `dashboardPort` | `4545` | Port of `grampus dashboard` when `--port` is not given |
| `dashboardHost` | `null` | Address the dashboard listens on; null is every interface (reachable from your network), `"127.0.0.1"` keeps it on this machine |
| `claudeCommand` | `["claude"]` | The Claude Code CLI, asked for its model aliases and effort levels by the recipe editor, and asked to name tasks |
| `titleModel` | `"haiku"` | The Claude model that names a task or comparison from its request when no title is given (letters, digits and `.:[]_-` only); `null` uses the request's first line |
| `titleTimeoutMs` | `30000` | How long naming may take before the request's first line is used instead |
| `codexCommand` | `["codex"]` | The Codex CLI, asked for its model catalog by the recipe editor |
| `comparisonConcurrency` | `2` | How many entries of a comparison run at once; the rest wait for a free place |
| `modelPrices` | built-in table (see below) | API list prices per model for estimated cost; entries replace single models |
| `dashboardAllowedHosts` | `[]` | Extra host names the dashboard answers to, such as a VPN name; localhost, this machine's name and its addresses are always allowed |
| `dashboardDiffBytes` | `1048576` (1 MiB) | Bytes of the legacy whole-task diff response; the Changes tab requests complete individual files |
| `healthProbeMs` | `30000` (30 s) | How long the System page reuses one check of Orca and its agent accounts, and how often it checks again |
| `healthProbeTimeoutMs` | `15000` (15 s) | Deadline for one of those checks; an Orca that takes longer counts as not answering |
| `healthHistoryMs` | `86400000` (24 h) | How far back the System page lists Orca hiccups and driver stops |
| `providerUsageWarnPercent` | `90` | An agent provider's usage limit at or above this percentage is a warning on the System page; 100% is an error |
| `keptVersions` | `3` | How many installed versions `npm run install:local` keeps, the selected one included |

## Model prices

Estimated cost multiplies each dispatch's tokens by US dollars per million tokens. The built-in table
holds the standard-tier list prices published on 2026-10-22 for the Claude 5.x models and OpenAI's
GPT-6 and GPT-5.6 models (Codex). Prices change; add or override models in `config.json`. Anything
without a price shows as unknown, never as free.

```json
{
  "modelPrices": {
    "gpt-6-luna": { "input": 0.1, "cachedInput": 0.01, "cacheWrite": 0, "output": 0.5 }
  }
}
```

## Recipes

A recipe names the agent, model and effort of each stage. An omitted model uses your Orca default for
that agent; an effort needs a model. `null` skips an optional stage.

```json
{
  "recipes": [
    {
      "name": "cheap-build",
      "spec": { "agent": "claude", "model": "opus" },
      "specReview": null,
      "testsFirst": { "agent": "claude", "model": "sonnet" },
      "build": { "agent": "codex", "model": "gpt-5.4-mini", "effort": "medium" },
      "review": { "agent": "claude", "model": "sonnet" },
      "polish": { "agent": "codex" },
      "explain": { "automatic": false, "assignment": { "agent": "claude" } },
      "repair": { "maxRounds": 2, "coverageGapRounds": 3, "reuseBuilderRounds": 1 }
    }
  ]
}
```

`polish` runs once after each ready round: a worker improves maintainability without changing
behaviour, and Grampus retains edits only if the guard, checks, behavioural review and maintenance
assessment all agree (see [Pipeline](ARCHITECTURE.md#pipeline)). It edits code, so it counts as an editor for cross-family
review. A recipe without the field has it off.

`explain.automatic` runs a read-only explanation worker on the final candidate after checks, review and
any kept polish. It defaults to false. The assignment also answers follow-up questions.

`repair.coverageGapRounds` allows automatic repairs when a review requests changes, identifies a
coverage gap or unverified outcome, and supplies a supported blocking finding with a file, line and
failing scenario. It is a separate allowance from `repair.maxRounds`, which covers ordinary repairs.
Each automatic decision consumes one round from the relevant allowance, even when both kinds of
problem occur together; coverage problems take precedence. Both counts survive driver restarts.
The field accepts 0 to 5 and defaults to 0 in saved recipes that omit it. Zero asks you immediately.
The dashboard recipe editor exposes it as **Automatic coverage repairs**.

Coverage repairs receive the original request, coverage evidence and limitations, and blocking
findings. They may fix requested behaviour omitted by the spec but cannot change the approved spec
or expand the request. Every attempt runs the checks and independent review again; remaining
coverage problems prevent readiness. Without a delivery policy, unknown request coverage or review verdicts, unavailable or
incomplete reviews, unsupported findings and worker failures escalate immediately. Delivery policies
first use their bounded report correction and investigation allowances. Exhausting
an allowance also escalates; a manual continuation grants one attempt without replenishing either
automatic allowance. Tasks retain the recipe copied at creation, so changes apply to new tasks.

The built-in `standard-codex` recipe is the default. `standard-claude` mirrors it with the agent
families swapped. Both use unattended delivery, independent specification review and no polish:

| Stage | `standard-codex` | `standard-claude` |
| --- | --- | --- |
| Spec, build | Codex `gpt-6.1-sol`, medium | Claude `claude-sonnet-5-5`, medium |
| Spec and code review | Claude `claude-sonnet-5-5`, medium | Codex `gpt-6.1-sol`, medium |
| Repair | Codex `gpt-6.1-sol`, high | Claude `claude-sonnet-5-5`, high |
| On-demand explanation | Claude, Orca default model | Codex, Orca default model |

Both disable polish, tests-first and automatic explanation. They allow two repair rounds,
plus three automatic coverage repair rounds, with the first repair eligible to continue the builder
conversation when its assignment matches.
The names are reserved: copy a built-in recipe to customise it. The old `standard` name is removed.
Same-family review is allowed only for supervised experiments; unattended recipes require independent review.
Model ids above are examples; use ids your Orca agents accept.

### Delivery authority and budgets

The standard recipes and new `adaptive-codex` and `adaptive-claude` recipes include:

```json
{
  "delivery": {
    "mode": "unattended",
    "maxSeconds": 1800,
    "maxCostUsd": null,
    "reportRetries": 1,
    "investigations": 1,
    "stageRetries": 1,
    "questionResolutions": 2
  }
}
```

The driver records automatic decisions under this mandate, never as user commands. An independently
reviewed specification with complete request coverage proceeds without an approval prompt. A ready
standalone task finishes as accepted without a final prompt. Comparisons still wait for an explicit pick.
Neither mode authorises merging, pushing, deploying, weakening checks or choosing new product behaviour.
The recipe editor exposes the policy and budgets. Omit `delivery` for the original supervised workflow,
or set its mode to `supervised` to retain approval gates while using bounded recovery and budgets.

`maxSeconds` is a positive elapsed-time budget from task creation, at most 86,400 seconds. It includes
recovery and product-decision waits. Selection of an already verified comparison entry is exempt while
the driver waits. Checks receive an abort signal; worker waits and new dispatches check the deadline.
An in-flight Orca call must resolve safely before its worker can be stopped, so this is not a hard
real-time termination guarantee. Exhaustion ends the task as **incomplete**, preserving its branch and
evidence. Restarting does not replenish the budget. Start a new task with a revised mandate if needed.

`maxCostUsd` is an optional positive estimated-dollar budget, at most 1,000. Before dispatch, Grampus
reads usage and current configured model prices. Unknown usage or pricing prevents another launch
under a spending cap. A running dispatch can overshoot: this is a dispatch admission budget, not a
provider billing limit. Without a cost cap, missing measurements remain explicitly unknown in reports.

Recovery allowances accept 0 to 3. Report correction retries the same spec or candidate, without a
rebuild. Investigations gather evidence for uncertain coverage and concrete correctness concerns.
Known failed starts and positively exited workers can be retried; uncertain launches retain the same
request id and must be reconciled. A bounded question resolver may answer implementation questions
with existing repository references. Product decisions, unsupported answers and exhausted recovery
allowances still reach the user. Interrupted setup is never blindly replayed.

### Cheap-first delivery

`adaptive-codex` uses `gpt-6-luna` at low effort for build and initial repairs; `adaptive-claude` uses
`claude-haiku-5-5` at low effort. They retain the standard recipes' specification and independent
review models, mandatory repository checks and acceptance criteria. Both omit polish.

Set `repair.fallback` to a stronger assignment and `repair.stagnantRounds` to the number of consecutive
rounds without a decrease in unresolved failure count (default 2, range 1 to 5). The driver switches
once, records why, and retains that choice across restarts. This count is a progress heuristic, not
proof that individual defects are identical. Fallback consumes the existing time, cost and repair
budgets, and cannot share the reviewer's family in unattended mode. Omit fallback for a pure-model
experiment. Report mixed-model runs as adaptive, not as cheap-only successes.

Use [the benchmark protocol](BENCHMARKS.md) to compare cost per verified result, success rate, latency
and interventions. Strong guardrails do not establish that cheap models have equal quality; tests
and independent review can themselves miss behaviour.

## Repository setup

Commit `grampus.json` at the repository root to declare preparation independently of acceptance checks:

```json
{
  "setup": {
    "name": "Install dependencies",
    "command": "pnpm install --frozen-lockfile",
    "timeoutSeconds": 900
  },
  "checks": [
    { "name": "Repository verification", "command": "pnpm run verify", "timeoutSeconds": 900 }
  ]
}
```

Grampus snapshots this configuration from the task's base commit and runs it once per fresh worktree
before spec writing. Use `{"setup": null}` to disable preparation. When `setup` is omitted, a root
`pnpm-lock.yaml` selects `pnpm install --frozen-lockfile`, otherwise a root `package-lock.json` selects
`npm ci`; other repositories have no inferred setup. Use an explicit command for other package
managers, nested projects or extra prerequisites. Commands use `checkShell` and the normal check
timeout settings. Generated dependencies must be ignored by Git; tracked changes or moving HEAD
make setup fail. Failures have their own logs and retry decision, not a failed behavioural baseline.
After interruption, stop any previous setup process before confirming a retry.

Before setup, a clean fresh checkout is normalised where Git reports LF in the index
and CRLF in the working file. Explicit `eol=crlf` attributes are respected. Binary,
mixed-ending and already-LF files are left alone. Grampus refreshes the affected
index entries and requires a clean tree afterwards; it never changes shared or
global Git settings. This prevents platform checkout conversion from consuming
feature repair rounds. Actual formatting defects still fail verification.

### Repository verification baseline

`checks` declares the mandatory repository verification baseline, independent of the recipe. The
driver snapshots it from the base commit alongside setup and includes it in the spec before approval.
Acceptance checks are added after it. The spec writer cannot omit or narrow these commands; their
timeouts and portability declarations also come from the snapshot. An identical command already in
the spec runs once, retaining its name so acceptance references remain valid. Conflicting check names
are rejected. The combined spec still has the normal limit of 12 checks.

Without explicit `checks`, Grampus selects the root `package.json` script `verify`, otherwise `check`.
It uses the declared npm, pnpm, Yarn or Bun `packageManager`, otherwise infers the manager from a root
lockfile, defaulting to npm. For example, PlayBeam's baseline is `pnpm run verify`; Grampus's own is
`npm run check`. Inference reads the base commit, never the worker's edited package scripts.

For other languages, nested projects or differently named commands, declare `checks` explicitly in
`grampus.json`. An explicit list must be non-empty and use unique names and commands. When neither
configuration nor a conventional script exists, no common baseline is inferred; the spec prompt names
that limitation and asks for the repository's standard checks. Grampus does not invent a successful gate.

The approved baseline runs before implementation, during every verification round and after polish.
Failed polish checks prevent launching its review. Shared comparisons inherit the same approved
baseline; full comparisons resolve it from their common base commit. Editing `grampus.json` later
does not change the recorded commands, and changes to it or package scripts are flagged for review.

Approved checks should contain verification only. A check may include `"portable": true` when it
uses stable existing public interfaces and can be run unchanged against independent implementations.
This declaration is part of spec approval; it is not inferred from a passing run. Undeclared
cross-check failures remain unknown unless the logs establish an execution or API incompatibility.

### Common behavioural harness

Declare `behaviouralHarness` in the base commit's `grampus.json` to give every
recipe the same behavioural checks:

```json
{
  "behaviouralHarness": {
    "contract": "Invoke the public greeting function and compare its returned string.",
    "files": ["test/common.test.js"],
    "checks": [{ "name": "Common behaviour", "command": "node test/common.test.js" }]
  }
}
```

List every harness test, fixture and helper as an exact committed repository-relative
file. Paths cannot contain traversal or globs. The contract, protected files and
checks enter the exact approved spec. Harness commands are portable by declaration:
approval must confirm they use stable public boundaries and suitable tolerances.
The declaration does not prove that private implementation assumptions are portable.
All checks run against each candidate; comparison overlays cannot replace harness
files, and changing them from the common base invalidates the cross-check.
Use a dedicated test command so unrelated overlaid tests cannot prevent the harness
from running. Existing repository checks remain mandatory.

[The Snake example](../examples/playbeam-snake/README.md) exercises roster changes,
round timing and public results without inspecting private simulation state. Commit
the harness before starting a new comparison; existing run evidence is not rewritten.

### Review probes and individual assertions

Implementation reviewers declare `probes`, using an empty array when none were
needed. Useful executable probes include their complete source, reproduction
command and suggested test path. A probe without an equivalent committed regression
uses the bounded coverage-repair allowance. Later reviews must retain the scenario
and cite its committed test file and test name. The driver checks that the file and
named text exist at the reviewed commit; the reviewer remains responsible for
confirming the test asserts the outcome and runs through approved checks. Omitting
a previous probe cannot silently drop the requirement. Reviewers cannot edit the candidate. With a
delivery policy, a separate Git copy of the exact commit permits new probe tests, with its own recorded
dependency setup. Grampus executes declared probes there and records their actual exit status and
source. Tracked edits, moved commits, traversal and symlink probe paths are refused. A failed claimed
committed regression makes the review unavailable. New useful probes require committed regressions
before readiness. The isolated workspace is not an operating-system security sandbox.

Cross-check assessments retain named assertion failures separately from command
verdicts, including when an infrastructure footer or incompatible test prevents
classifying the whole command. CLI status and the dashboard show each test, assertion
and portability status. Unknown is never counted as behavioural failure or success.
The parser recognises named Vitest/Jest and TAP failure sections; unsupported output
remains available in the full log. Displayed evidence is bounded by `checkLimits`.

## Correction attribution

When sending `continue`, `revise`, `reply` or `retry`, optionally add
`--purpose implementation` or `--purpose workflow`. The dashboard offers the same classification
for revision and continuation. Omit it when the cause is unknown. It affects measurement only,
not what the driver does or which decisions require the user.

## Polish configuration

Set a recipe's `polish` assignment to enable the pass, or null to disable it. Use a reviewer as well:
without one, edits cannot be retained. The worker reports naming, duplication, structure, cleanup or
consistency improvements, with concrete benefits and an explanation for adjacent edits. The fixed
adjacent-file bound is `polishLimits.adjacentFiles` in `src/config/limits.ts`. Behaviour and maintenance
value are reviewed separately. No worthwhile improvement is a successful no-op. There is no automatic
repair budget for polish, and a failed attempt restores the previously verified commit.

Polish welcomes improvements to readability, maintainability, consistency, simplicity and naming,
including standalone improvements. The worker explains the issue and benefit; it does not need to
justify a hypothetical future edit. The independent reviewer assesses whether the change improves
the code and preserves behaviour. Reports live in the worktree's private Git metadata so they cannot
enter source commits.

The old `simplify` recipe key is rejected by the strict recipe schema. Task logs use schema 7 and
comparison logs schema 4; old evidence remains on disk but is not migrated by this version.
