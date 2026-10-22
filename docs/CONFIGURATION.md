# Configuration

Grampus reads `<data directory>/config.json` when it exists. Every field is optional; an invalid file
is refused rather than ignored. The data directory is `GRAMPUS_HOME`, or `--home <dir>` for one
command, or `%LOCALAPPDATA%\Grampus\orca` on Windows.

| Setting | Default | Meaning |
| --- | --- | --- |
| `orcaCommand` | `["orca"]` (or `ORCA_CLI_COMMAND`) | The Orca CLI and any leading arguments |
| `orcaCallTimeoutMs` | `600000` | Deadline for one Orca call; `worker-start` waits for setup and readiness |
| `gitTimeoutMs` | `60000` | Deadline for one Git query |
| `inboxWaitMs` | `5000` | How long the driver blocks on Orca's inbox before reading local commands |
| `livenessIntervalMs` | `60000` | Minimum interval between liveness checks of unreported workers |
| `waitTimeoutSeconds` | `540` | How long `grampus wait` blocks before reporting nothing new |
| `waitPollMs` | `2000` | How often `grampus wait` rereads task logs |
| `defaultCheckTimeoutSeconds` | `900` | Check timeout when the spec sets none (at most 3600) |
| `checkShell` | `null` | Shell for check commands; null uses cmd.exe on Windows and /bin/sh elsewhere |
| `testFilePatterns` | `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**` | Paths the guard treats as tests |
| `recipes` | `[]` | Saved recipes beside the built-in `standard` recipe |
| `claudeProjectRoots` | `["<CLAUDE_CONFIG_DIR or ~/.claude>/projects"]` | Where Claude session transcripts are searched for measurement |
| `codexSessionRoots` | `["<CODEX_HOME or ~/.codex>/sessions"]` | Where Codex rollouts are searched for measurement |

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
tests-first stage, and two repair rounds of which the first continues the builder's conversation.
Review from the builder's own family is allowed so it can be measured; the task records which ran.
Model ids above are examples; use ids your Orca agents accept.
