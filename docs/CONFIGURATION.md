# Configuration

Grampus works without any configuration. An optional `config.json` in the data directory
overrides a small set of operational settings. Edit it on the dashboard's **Settings** screen or by
hand. Limits that are part of approval, evidence
or recovery are fixed in code and cannot be configured.

## Where the file lives

`config.json` sits in the data directory, next to the default journal:

| Launch | File on Windows |
| --- | --- |
| Installed `grampus` | `%LOCALAPPDATA%\Grampus\installed\config.json` |
| Development checkout | `%LOCALAPPDATA%\Grampus\development\<checkout-id>\config.json` |
| `GRAMPUS_HOME` set | `%GRAMPUS_HOME%\config.json` |

`grampus version` prints the data directory. `--db` chooses another journal but does not
move the settings file. Only the Settings screen writes `config.json`; nothing else creates or
rewrites it.

The file is read once when the CLI or dashboard starts (`grampus update` does not read it, so
an invalid file cannot block an update). Restart the dashboard after editing it, including after
saving on the Settings screen. Dashboard actions and supervised implementation turns use the values loaded at startup,
never a newer copy of the file.

## The Settings screen

**Settings** in the dashboard sidebar shows one field per setting with the value stored in the
file. An empty field is left out of the file and keeps the built-in default, so a later change of
a default still applies. Quality pass settings and the model catalogue also have JSON fields; the dedicated Model profiles screen provides structured profile editing.

Saving validates the values with the same rules as startup and writes only the keys that have a
value. If the file changed since the screen was shown (by hand or from another tab), the save is
refused and the screen shows the current file. The screen also says when the saved file differs
from the settings the dashboard started with, and when the saved file would be refused at the next
start; saving a valid form replaces such a file. A running dashboard never applies saved settings:
close it and start it again.

## Format

A JSON object with any subset of the keys below. Omitted keys keep their defaults. Unknown
keys, wrong types, out-of-range values and inconsistent pairs (an `outputFlushIntervalMs` not
shorter than the effective `stallWarningMs`, which would make every streaming turn look stalled)
are refused at startup with an error naming the file and each offending key, for example:

```text
Invalid settings in C:\Users\me\AppData\Local\Grampus\installed\config.json: unknown key "dashbordPort"
```

Example:

```json
{
  "dashboardPort": 4400,
  "defaultCheckTimeoutMs": 180000,
  "defaultWorkflowPolicy": { "repairRounds": 1 }
}
```

## Settings

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `dashboardPort` | `4317` installed, `4318` development | 1 to 65535 | Loopback port of the dashboard. `--port` still overrides it for one launch. A port browsers refuse (such as 6000 or 10080) stops the dashboard from starting |
| `dashboardRequireAccessLink` | `false` | `true`, `false` | Require the per-launch access link for the dashboard API. Off permits direct local access; loopback, host and origin checks still apply. Desktop discovery and shutdown always require their private token. Restart Grampus to apply |
| `dashboardStartupMs` | `30000` | 1000 to 120000 | How long a background launcher waits for authenticated readiness; an uncertain process is retained |
| `dashboardProbeMs` | `2000` | 100 to 30000 | Deadline for one authenticated local discovery or shutdown request |
| `dashboardPollMs` | `100` | 50 to 1000 | Interval between observations while a background dashboard starts |
| `usagePollIntervalMs` | `15000` | 1000 to 600000 | How often Claude usage is sampled during a turn. The final result always replaces the samples |
| `liveChangesIntervalMs` | `5000` | 1000 to 600000 | Interval between display-only working tree observations while the task screen is visible. No agent calls or evidence writes |
| `observabilityIntervalMs` | `1000` | 1000 to 600000 | Interval between display-only activity journal reads while the execution graph is visible. Replay and hidden pages stop polling; no agent calls |
| `orcaSyncIntervalMs` | `5000` | 1000 to 600000 | Interval between journal observations for Orca worktree cards while the dashboard is open. Only changed cards are sent; updates never launch an agent or change workflow state |
| `outputFlushIntervalMs` | `1000` | 100 to 60000, and shorter than `stallWarningMs` | Longest time streamed agent output is held in memory before it is journaled as one event. A crash loses at most this much display-only text |
| `outputFlushBytes` | `8192` | 1024 to 1048576 | Buffered streamed output (UTF-8 bytes) that is journaled at once without waiting for the interval |
| `defaultPreparationTimeoutMs` | `600000` | 100 to 600000 | Timeout written into new plans for preparation commands that omit `timeoutMs`. Preparation restores dependencies in a fresh worktree without caches, so it gets the longest allowed time |
| `defaultCheckTimeoutMs` | `300000` | 100 to 600000 | Timeout written into new plans for readiness, validation and acceptance commands that omit `timeoutMs` |
| `defaultWorkflowPolicy` | see below | see below | Workflow policy for new plans that omit it, or omit some of its fields |
| `qualityPasses` | `[]` | up to 16 definitions | Custom quality passes a plan may select by id, in addition to the built-ins (see below) |
| `defaultQualityPasses` | `["simplification"]` | up to 6 distinct known ids, or `[]` | Quality passes selected for new plans that omit `quality` |
| `maxConcurrentTasks` | `2` | 1 to 4 | Guided tasks that may run at once, each in its own worktree. While this many own a runner (tasks awaiting recovery included), starting work on another task is refused, never queued; recovery, revision and workspace release are not limited. Also bounds simultaneous guided agent turns, one per task ([parallel tasks](ARCHITECTURE.md#parallel-tasks-and-concurrency)) |
| `stallWarningMs` | `600000` | 1000 to 86400000, and longer than `outputFlushIntervalMs` | Silence after which a running agent turn or check of a guided task is shown as possibly stalled (a dashboard badge and one timeline entry per silence). Nothing is stopped. Read by the dashboard server |
| `healthCheckIntervalMs` | `600000` | 1000 to 86400000 | Age after which the stored integration health is checked again automatically, when the dashboard starts and before a guided run it starts. `grampus doctor` and **Check again** always check |

`defaultWorkflowPolicy` is an object with any of these fields:

| Field | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `mode` | `"automatic"` | `"automatic"`, `"supervised"` | Automatic runs to a verified commit; supervised stops at file authorization and quality assessment |
| `readinessRounds` | `2` | 0 to 10 | Separate automatic repairs per slice for declared formatting, lint and type checks; retries and behavioural repairs never replenish it |
| `repairRounds` | `3` | 0 to 10 | Shared automatic repair rounds per slice across behavioural validation, review and acceptance; progress checks can stop earlier |
| `maxTaskTurns` | `20` | 1 to 1000 | Requested provider turns across linked planning, retries, slices and all plan versions; exhaustion stops before another turn |
| `maxTaskTokens` | `0` | 0 to 1000000000 | Task token threshold; zero disables only the token gate. When enabled, missing or partial usage stops another turn. Active turns may exceed it |
| `maxSessionTurns` | `6` | 1 to 50 | Turns before a fresh provider conversation |
| `maxContextTokens` | `120000` | 8000 to 1000000 | Observed input tokens before a fresh provider conversation |

Task spending defaults are copied into each new plan and covered by approval. See [task-wide allowances](WORKFLOW.md#task-wide-spending-allowances) for counting, unknown usage and the limits of dispatch thresholds.

Each entry of `qualityPasses` is a strict object:

| Field | Allowed | Meaning |
| --- | --- | --- |
| `id` | kebab-case, at most 40 characters, not a built-in id, unique | How plans and verdicts name the pass |
| `title` | nonempty, at most 120 bytes | Shown at approval and on the dashboard |
| `kind` | `"lens"`, `"edit"` | A lens is assessed by the independent reviewer; an edit pass is a scoped implementer turn before validation |
| `instructions` | nonempty, at most 4096 bytes | Sent verbatim to the agent |

```json
{
  "qualityPasses": [
    {
      "id": "error-handling",
      "title": "Error handling",
      "kind": "lens",
      "instructions": "Assess whether every new failure path is reported with enough context to act on."
    }
  ],
  "defaultQualityPasses": ["simplification", "error-handling"]
}
```

The built-ins are `simplification`, `naming`, `refactor` and `documentation`
([quality passes](WORKFLOW.md#quality-passes)). A plan stores the full definitions it selected,
so removing or editing a custom pass later never changes an approved plan; a revision keeps
the definitions already in the plan.

## Model profiles

`modelProfiles` defaults to `[]` and accepts up to 32 named definitions. The dashboard's
**Model profiles** screen edits this catalogue with provider, model and reasoning effort inputs.
Model inputs offer suggestions discovered from the local Codex and Claude agents without an
inference turn, and still accept a model ID typed by hand. Discovery does not write `config.json`.
Its save preserves other settings and refuses a stale file revision. An example definition is:

```json
{
  "modelProfiles": [
    {
      "id": "balanced",
      "name": "Balanced",
      "planning": { "provider": "codex", "model": null, "effort": "high" },
      "implementation": { "provider": "codex", "model": null, "effort": "medium" },
      "repair": { "provider": "codex", "model": null, "effort": "high" },
      "review": { "provider": "claude", "model": null, "effort": "high" },
      "qualityPasses": {
        "documentation": { "provider": "codex", "model": null, "effort": "low" }
      }
    }
  ]
}
```

Use explicit model ids to compare particular models; `null` chooses the provider default and
Grampus records the observed model when the provider reports it. Profile ids are unique, start
with a lower-case letter and contain letters, digits, underscores or hyphens. Ids, names and model
ids are limited to 200 characters. `planning`, `implementation` and `review` are required;
`repair`, `qualityPasses` and `arbitration` are optional. There are at most six edit-pass assignments.
Repair and edit passes retain the implementation provider. Review uses the other provider.

Effort may be omitted for the provider default. Codex accepts `none`, `minimal`, `low`, `medium`,
`high`, `xhigh` and `max`; Claude accepts `low`, `medium`, `high`, `xhigh` and `max`. A particular model can
support fewer choices. Grampus sends the requested model and effort directly and does not implement
a fallback; model-specific support belongs to the provider. Requested choices and any observed model
are recorded separately. An omitted repair or edit assignment inherits implementation. An arbitration
assignment enables arbitration; omitting it leaves arbitration disabled for that profile.
An edit assignment does not itself enable its quality pass.

A plan may name a catalogue entry with `"modelProfile": "balanced"` or include the full profile
object. Normalisation copies the definition into approval. The dedicated profile picker reads
the saved catalogue and explicitly submits a selected snapshot for a new task, so new selections
can use a newly saved profile without restarting the dashboard. This does not hot-apply operational
settings or alter existing plans. CLI commands read the catalogue with settings at process startup.

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
configurable. The dashboard server looks for stalls every 15 seconds and bounds health checks
(`stallLimits` and `healthLimits` in `src/config/limits.ts`).
