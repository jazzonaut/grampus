# Configuration

Grampus works without any configuration. An optional `config.json` in the data directory
overrides a small set of operational settings. Limits that are part of approval, evidence
or recovery are fixed in code and cannot be configured.

## Where the file lives

`config.json` sits in the data directory, next to the default journal:

| Launch | File on Windows |
| --- | --- |
| Installed `grampus` | `%LOCALAPPDATA%\Grampus\installed\config.json` |
| Development checkout | `%LOCALAPPDATA%\Grampus\development\<checkout-id>\config.json` |
| `GRAMPUS_HOME` set | `%GRAMPUS_HOME%\config.json` |

`grampus version` prints the data directory. `--db` chooses another journal but does not
move the settings file. Grampus only reads `config.json`; it never creates or rewrites it.

The file is read once when the CLI or dashboard starts (`grampus update` does not read it, so
an invalid file cannot block an update). Restart the dashboard after editing it. Dashboard actions and supervised implementation turns use the values loaded at startup,
never a newer copy of the file.

## Format

A JSON object with any subset of the keys below. Omitted keys keep their defaults. Unknown
keys, wrong types and out-of-range values are refused at startup with an error naming the
file and each offending key, for example:

```text
Invalid settings in C:\Users\me\AppData\Local\Grampus\installed\config.json: unknown key "dashbordPort"
```

Example:

```json
{
  "dashboardPort": 4400,
  "defaultCheckTimeoutMs": 300000,
  "defaultWorkflowPolicy": { "repairRounds": 1 }
}
```

## Settings

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `dashboardPort` | `4317` installed, `4318` development | 1 to 65535 | Loopback port of the dashboard. `--port` still overrides it for one launch |
| `usagePollIntervalMs` | `15000` | 1000 to 600000 | How often Claude usage is sampled during a turn. The final result always replaces the samples |
| `defaultCheckTimeoutMs` | `120000` | 100 to 600000 | Timeout written into new plans for validation, acceptance and preparation commands that omit `timeoutMs` |
| `defaultWorkflowPolicy` | see below | see below | Workflow policy for new plans that omit it, or omit some of its fields |
| `maxConcurrentTasks` | `2` | 1 to 16 | **Planned:** guided tasks that may run at once. Accepted but not used yet |
| `stallWarningMs` | `600000` | 1000 to 86400000 | **Planned:** silence after which a running turn or check is shown as possibly stalled. Accepted but not used yet |

`defaultWorkflowPolicy` is an object with any of these fields:

| Field | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `mode` | `"automatic"` | `"automatic"`, `"supervised"` | Automatic runs to a verified commit; supervised stops at file authorization and simplification assessment |
| `repairRounds` | `2` | 0 to 5 | Automatic repair rounds per slice after failed validation or acceptance |
| `maxSessionTurns` | `6` | 1 to 50 | Turns before a fresh provider conversation |
| `maxContextTokens` | `120000` | 8000 to 1000000 | Observed input tokens before a fresh provider conversation |

## What settings do not change

Defaults apply only when a plan is created. The resulting values are written into the plan
and covered by its approval digest, so changing `config.json` never alters an approved plan,
a running task or recorded evidence. A planning proposal that is already shown keeps the
values it was created with; only proposals produced after a restart use the new defaults.

Fixed limits are in `src/config/limits.ts`, each documented with what it bounds. They
include edit and patch sizes, file-size limits checked before approval, the 64 KiB journal
preview per check stream, review history limits, repository read budgets and process
timeouts. They are not configurable because changing one would change what an approval or a
piece of evidence means. Repository read budgets are described in
[REPOSITORY-CONTEXT.md](REPOSITORY-CONTEXT.md).

The dashboard's own polling interval (1.5 seconds) is set in the browser client and is not
configurable.
