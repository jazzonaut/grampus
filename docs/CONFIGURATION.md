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
| `checkConfigPatterns` | `**/Directory.Build.props`, `**/Directory.Build.targets`, `**/*Tests.csproj`, `**/*Test.csproj`, `**/test/**/*.csproj`, `**/tests/**/*.csproj`, `**/*.runsettings`, `**/testconfig.json`, `**/global.json`, `**/package.json`, `**/tsconfig*.json`, `**/vitest.config.*`, `**/vitest.workspace.*`, `**/jest.config.*`, `**/playwright.config.*`, `**/eslint.config.*`, `**/.eslintrc*`, `**/eslint-suppressions.json`, `**/pyproject.toml`, `**/pytest.ini`, `**/setup.cfg`, `**/tox.ini`, `**/conftest.py`, `**/Makefile` | Paths outside the tests that configure how checks run; the guard names changes to them, and to files a check command names, for the reviewer and the user |
| `crossCheckIncompatiblePatterns` | C# and TypeScript compiler errors, missing modules and exports, Python import errors, Java `cannot find symbol`, Rust `error[E…]` | Regular expressions that mark a failed cross-check as incompatible: the copied tests did not compile or load against that entry |
| `checkInfrastructurePatterns` | Missing command/module, no-tests and `ENOENT` signatures | Case-insensitive regular expressions for execution failures; these never count as behaviour evidence |
| `checkAssertionPatterns` | `AssertionError`, `ERR_ASSERTION`, expected/received and `Assert.` signatures | Recognised assertions; cross-check behavioural attribution additionally requires a portable check |
| `recipes` | `[]` | Saved recipes beside the built-in `standard` recipe |
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
      "repair": { "maxRounds": 2, "reuseBuilderRounds": 1 }
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

The built-in `standard` recipe uses Claude for spec and review, Codex for spec review and build, no
tests-first or polish stage, and two repair rounds of which the first continues the builder's conversation. The
spec review runs `gpt-6.1-sol` at medium effort: at high effort it was the slowest stage and found
nothing blocking in six runs (Orca accepts an effort only together with a model).
Review from the builder's own family is allowed so it can be measured; the task records which ran.
Model ids above are examples; use ids your Orca agents accept.
## Repository setup

Commit `grampus.json` at the repository root to declare preparation independently of acceptance checks:

```json
{
  "setup": {
    "name": "Install dependencies",
    "command": "pnpm install --frozen-lockfile",
    "timeoutSeconds": 900
  }
}
```

Grampus snapshots this configuration from the task's base commit and runs it once per fresh worktree
before spec writing. Use `{"setup": null}` to disable preparation. Without the file, a root
`pnpm-lock.yaml` selects `pnpm install --frozen-lockfile`, otherwise a root `package-lock.json` selects
`npm ci`; other repositories have no inferred setup. Use an explicit command for other package
managers, nested projects or extra prerequisites. Commands use `checkShell` and the normal check
timeout settings. Generated dependencies must be ignored by Git; tracked changes or moving HEAD
make setup fail. Failures have their own logs and retry decision, not a failed behavioural baseline.
After interruption, stop any previous setup process before confirming a retry.

Approved checks should contain verification only. A check may include `"portable": true` when it
uses stable existing public interfaces and can be run unchanged against independent implementations.
This declaration is part of spec approval; it is not inferred from a passing run. Undeclared
cross-check failures remain unknown unless the logs establish an execution or API incompatibility.

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

The old `simplify` recipe key is rejected by the strict recipe schema. Task logs use schema 3 and
comparison logs schema 2; old evidence remains on disk but is not migrated by this version.
