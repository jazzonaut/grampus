# Execution efficiency

The controller remains responsible for approval, evidence, recovery and Git delivery. The
implementation agent can complete more investigation and repair inside its approved execution.
These features reduce avoidable work; they do not establish a measured speed-up.

## Finish current work within the implementation turn

Both providers can call `grampus_run_check` with `name: "finish"`. The controller runs the
approved formatter, the readiness checks with their approved concurrency, then validation.
A formatting or readiness failure stops the cycle before later checks. Ordinary failures
return to the active agent for repair. Each actual command spends the existing in-turn
command allowance, so repeating a cycle is bounded. Acceptance remains separate.

All readiness child requests are journalled before dispatch, under the implementation lease.
Each child has its own receipt. The whole operation suspends native writes; uncertain
children keep writes suspended and retain the parent lease until recovery proves exit.
An independent read-only wave shares stable before/after captures. Its after capture is
available only once every child has a confirmed exit; any mutation invalidates every
child in that wave. Later waves take fresh captures. No mutable verification bytes are cached.
Recovery never repeats a command or accepts a lost success. Independent review and final
artifact-bound gates are unchanged.

Successful diagnostics return identity, outcome and artifact rather than verbose output.
Failures retain useful excerpts; `grampus_read_check` can retrieve complete durable logs.
The optional existing readiness/validation `reuse` declaration still controls gate adoption.
An explicitly repeatable formatter can also declare `reuse: {"inputs":["node_modules"]}`.
The final automatic formatter is skipped only when its latest successful receipt observed
no artifact change and its input artifact, exact command, instructions and before/after declared
input fingerprints still match the current state. A formatter that changed files runs again.
Without that declaration the final automatic formatter still runs.

## Diagnostic attempts and reliable settlement

Exhaustion creates a durable `DIAGNOSTIC_ALLOWANCE_REQUIRED` checkpoint before review or
acceptance. The dashboard displays the family and proposed increase, up to two more attempts
and never beyond eight. Approval records a supplement bound to the existing plan digest,
version and slice. Earlier spending, file scope and final checks remain unchanged. Ordinary
answers cannot grant it. Questions from the same turn are answered in the allowance approval
form, so permission and answers take effect together. At the fixed ceiling, revise the plan.
The CLI equivalent is `task-diagnostic-allowance <id> <decision-key> [answers.json]`.

Repairs extract explicit failed-case headings from retained Playwright summaries and map
complete selections to an existing approved diagnostic family. `grampus_run_check(name: "repair")`
runs those cases; `finish` runs them after formatting and before readiness and validation.
A failing probe returns immediately to the implementer. Case titles are escaped, paths and
parameters retain their approved inventory and grammar checks, and diagnostic budgets still
apply. Unknown, incomplete or unsupported output cannot invent a selection or establish success.
Pure browser-context teardown failures stop as `CHECK_ENVIRONMENT_FAILED` without spending an
implementation repair; mixed assertion and lifecycle failures retain every observed failed case.
An explicit rerun still runs the original stopped check, and final acceptance retains full coverage.
The worker also ensures a focused probe exists for the final edited artifact before settlement.
It does not repeat an already observed failure on unchanged bytes. The controller returns failed
or missing probes to a scoped turn in the same attempt before broad gates, under the existing
task-turn and diagnostic allowances. A provider message alone cannot bypass this focused loop.

Each diagnostic family has an approval-bound `maxRuns` per slice, defaulting to three
and limited to eight. Every parameter/file selection and repair attempt spends the same
durable allowance. Reservations precede dispatch, so a crash cannot reset spending.
The approval card shows the limit and tool feedback includes the remaining attempts.
Increasing it requires explicit supplemental approval or a revised plan and fresh approval.

After a failed diagnostic, the next call must use the approved case-selection parameters
or a smaller file selection when the runner supports case selection. Repeating the same
whole-file suite is not a focused rerun. Agents inspect retained assertions and relevant
source before spending another attempt. Final approved validation and acceptance retain
their complete coverage; diagnostic exhaustion cannot waive either gate.

Explicitly repeatable diagnostics may declare `reuse: {"inputs":["node_modules"]}`.
Across settled turns of one execution, a repeated exact command on unchanged artifact, instructions
and declared inputs returns the existing successful receipt without another process or
attempt. Missing inputs, changed dependencies and later matching failures disable reuse.
Browser, network and clock-dependent checks remain ineligible without a complete
repeatability contract. No result is inferred merely because a command already ran.

Provider completion now waits for already-dispatched diagnostic calls before shutdown
or automatic formatting. New edits and tool requests are refused after terminal provider
completion; pending children retain ownership until confirmed settlement. Unknown exits
still require recovery, without replay.

A reviewer may attach provisional findings, lens assessments and prior-finding observations
to a structured question. They survive validation and remain visible while an answer is
pending. Only a subsequent settled review can supply review or quality evidence.

The dashboard observes controller identities asynchronously, at most once per stall-scan
interval for each identity. A missing original process or a reused PID changes the display
to **Controller recovery needed** and offers recovery first, even without a journal change.
Remote hosts and failed inspection remain unknown. Observation never releases ownership,
recovers work or starts a replacement operation.

## More useful exploration

`grampus_search` accepts either `query` or up to eight `queries`, an optional path substring,
an optional `glob`, and `mode: "files"` for matching paths without line snippets. Queries
share one bounded scan. Matching lines report their queries without repeating the same line.
All scan and output bounds, omissions, reference roots and continuation requests still apply.

`grampus_read_files` accepts either `paths` for short initial pages or
`ranges: [{"path":"src/example.ts","offset":40,"limit":30}]`. Offsets count zero-based
lines. Each result retains its own continuation. Both providers advertise and enforce the
same argument contract. Combined output must fit the existing batch budget.

## Explicit directory grants

A slice can retain exact file actions and additionally approve directory grants:

```json
{
  "scope": {
    "files": [],
    "directories": [
      {"path":"src/feature","actions":["edit","create"],"suffixes":[".ts"]},
      {"path":"test","actions":["edit","create"],"suffixes":[".test.ts"]}
    ]
  }
}
```

The agent chooses matching files and can create nested directories without another plan
revision. Grants are segment-aware and are shown in approval and scope inspection. They
do not include sibling directories, other suffixes, repository/provider control files,
instruction files, Git operations or shell execution. Deletion requires an explicit
`delete` action and unchanged input bytes at the deletion tool. Symlinks, aliases,
binary files and executable-bit changes remain refused.

The existing per-file, changed-path and aggregate text bounds still apply to the final
artifact. A no-change slice cannot grant file actions. Read access never expands writes.
Both native provider tool decisions and final scope verification enforce these grants.
Native creations are also checked against controller-journalled tool approvals, so a later
ignore-file edit cannot hide surviving source files from the final artifact.

## Restore prerequisites only when required

A top-level prerequisite preparation command may declare:

```json
{
  "restore": {
    "inputs": ["package.json","package-lock.json","scripts/install-local.cjs"],
    "outputs": ["node_modules"]
  }
}
```

This is an explicit claim that restoration depends entirely on those local inputs,
the executable, runtime, inherited environment and repository instructions. Include
all relevant configuration, patches and lifecycle scripts. Network state, clocks or
uncontrolled external configuration make a command ineligible. Hashes, not environment
values, are retained.

The controller may adopt a completed restore only in the same task version and workspace,
with the exact command and declaration, unchanged inputs and matching managed output
bytes. Missing, aliased or oversized trees force execution. A later failed or uncertain
matching restore supersedes previous success. Adoption takes fresh before/after snapshots
and refuses changes during observation. Source edits outside the declared restore inputs
do not alone invalidate installation. Scoped generation after implementation still runs;
it cannot carry this restore contract. Without a declaration, preparation always runs.
When both generation and a declared top-level restore are configured, generation settles
first and restoration is then reconsidered against the final inputs before checks.
Each operation has a separate durable step; pausing or recovery between them does not
repeat an already completed generation of the current artifact.

## Measure context and process overhead

An exclusive finishing operation shares its trusted capture until a command supplies a fresh
after-capture. Native writes remain suspended throughout. The capture is discarded before the
tool call returns; later calls, recovery and final gates take fresh captures. Explicitly repeatable
check receipts may be adopted across completed turns of the same execution. Later matching
failures, uncertain parents or changed inputs prevent adoption. Planning guidance now asks for
complete reuse contracts and independent readiness concurrency where eligible, fast relevant
integration checks before broad acceptance, and a justification for expensive full browser suites.
Shards bound command deadlines rather than creating parallelism. User and repository coverage
requirements remain binding, and model profile assignments are never silently overridden.

New plans default `maxContextTokens` to zero: rotate at 75% of the model's observed context
window, or 120,000 tokens when the window is unknown. Positive approved limits remain binding.
Turn and task spending bounds still apply. New exploring Codex turns defer editable content by
default, retaining instructions, authorisation and explicit selected context. Compare measured
total tokens and wall time when choosing an installation override; no speed-up is inferred.

Execution journals record monotonic measurements for provider startup, turn and shutdown,
repository snapshots, input fingerprints and supervised commands. Scorecard JSON exports
and Markdown reports aggregate measured phases. Nested intervals overlap, so do not add
them to workflow elapsed time. Missing measurements stay absent. Reuse misses record
whether input fingerprints were unknown or no matching trusted source was available.

The operational setting `deferEditableContext` defaults to `true`. Fresh
exploring Codex turns read editable text on demand rather than receiving all editable
contents up front. Explicit starting context, authorisation and applicable instructions
remain available. Non-exploring turns still require complete supplied context. Compare
total input/output/cache tokens, tool calls, rereads and completion time when comparing eager
and deferred context. Explicit conversation reset limits remain binding.

## Repeatable direct-agent comparisons

After `npm run build:server`, run:

```text
npm run probe:efficiency -- path/to/manifest.json
```

The manifest contains `repository`, `base`, `repetitions` (1 to 10), `setup`, `verify`,
and exactly three `arms`, named `direct`, `direct_with_gates` and `grampus`.
Each arm supplies `commands` and `resultDirectory`. Each command is
`{"file":"node","args":["script.cjs"],"timeoutMs":300000}`; other executables require
absolute paths. Use `{repo}`, `{output}` and `{result}` placeholders in arguments.
`resultDirectory` resolves inside the retained arm directory, for example `.` for direct
work or `{output}/workspace` for a Grampus worktree created by the configured command.

All arms start from separate local clones of the same resolved commit, with separate Git
metadata. Setup runs before the timed implementation. Shared verification runs on each
successful implementation; a zero agent exit alone does not establish correctness. Arm
order rotates across repetitions. The probe retains clones, per-command requests and
supervisor receipts, logs and incremental `result.json` files. An uncertain operation
stops the probe without retry or automatic deletion. A clone is not a security sandbox.

Provide the same request, pinned provider version, model, reasoning effort and quality
coverage. Configure any Grampus commands with a dedicated development data directory,
never the installed application or journal. The probe does not choose models or start
inference without supplied commands. Provider token counters must come from retained
provider or Grampus exports; command output is not interpreted as a token measurement.
The automated probe test uses local fixture commands, not live model comparisons.

**Planned, conditional on measurements:** supervised warm provider workers if startup
is material, and isolated general command execution if bounded diagnostics and directory
grants still cause consequential friction. Warm workers need durable turn fencing and
shutdown proof. A worktree or executable allowlist does not contain arbitrary code.
These policies are not enabled by this implementation.

Journal schema 13 records approval-bound diagnostic budgets, restore fingerprints and directory grants. Other schema
versions are refused without migration. Use a fresh development journal; the installed
application and its journal are separate.
