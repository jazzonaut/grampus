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
| `waitTimeoutSeconds` | `540` | How long `grampus wait` blocks before reporting nothing new |
| `waitPollMs` | `2000` | How often `grampus wait`, the dashboard and comparison drivers reread logs |
| `defaultCheckTimeoutSeconds` | `900` | Check timeout when the spec sets none (at most 3600) |
| `checkShell` | `null` | Shell for check commands; null uses cmd.exe on Windows and /bin/sh elsewhere |
| `testFilePatterns` | `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**` | Paths the guard treats as tests |
| `checkConfigPatterns` | `**/Directory.Build.props`, `**/Directory.Build.targets`, `**/*Tests.csproj`, `**/*Test.csproj`, `**/test/**/*.csproj`, `**/tests/**/*.csproj`, `**/*.runsettings`, `**/testconfig.json`, `**/global.json`, `**/package.json`, `**/tsconfig*.json`, `**/vitest.config.*`, `**/vitest.workspace.*`, `**/jest.config.*`, `**/playwright.config.*`, `**/eslint.config.*`, `**/.eslintrc*`, `**/eslint-suppressions.json`, `**/pyproject.toml`, `**/pytest.ini`, `**/setup.cfg`, `**/tox.ini`, `**/conftest.py`, `**/Makefile` | Paths outside the tests that configure how checks run; the guard names changes to them, and to files a check command names, for the reviewer and the user |
| `crossCheckIncompatiblePatterns` | C# and TypeScript compiler errors, missing modules and exports, Python import errors, Java `cannot find symbol`, Rust `error[E…]` | Regular expressions that mark a failed cross-check as incompatible: the copied tests did not compile or load against that entry |
| `recipes` | `[]` | Saved recipes beside the built-in `standard` recipe |
| `claudeProjectRoots` | `["<CLAUDE_CONFIG_DIR or ~/.claude>/projects"]` | Where Claude session transcripts are searched for measurement |
| `codexSessionRoots` | `["<CODEX_HOME or ~/.codex>/sessions"]` | Where Codex rollouts are searched for measurement |
| `dashboardPort` | `4545` | Port of `grampus dashboard` when `--port` is not given |
| `dashboardHost` | `null` | Address the dashboard listens on; null is every interface (reachable from your network), `"127.0.0.1"` keeps it on this machine |
| `claudeCommand` | `["claude"]` | The Claude Code CLI, asked for its model aliases and effort levels by the recipe editor |
| `codexCommand` | `["codex"]` | The Codex CLI, asked for its model catalog by the recipe editor |
| `comparisonConcurrency` | `2` | How many entries of a comparison run at once; the rest wait for a free place |
| `modelPrices` | built-in table (see below) | API list prices per model for estimated cost; entries replace single models |
| `dashboardAllowedHosts` | `[]` | Extra host names the dashboard answers to, such as a VPN name; localhost, this machine's name and its addresses are always allowed |
| `dashboardDiffBytes` | `1048576` (1 MiB) | Bytes of a task's diff the dashboard shows in View full diff; a longer diff is cut |
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
      "repair": { "maxRounds": 2, "reuseBuilderRounds": 1 }
    }
  ]
}
```

The built-in `standard` recipe uses Claude for spec and review, Codex for spec review and build, no
tests-first stage, and two repair rounds of which the first continues the builder's conversation. The
spec review runs `gpt-6.1-sol` at medium effort: at high effort it was the slowest stage and found
nothing blocking in six runs (Orca accepts an effort only together with a model).
Review from the builder's own family is allowed so it can be measured; the task records which ran.
Model ids above are examples; use ids your Orca agents accept.
