# Initial integration evidence

## Windows installer file-handle correction — 18 October 2026

After the initial installation commit, an interactive update failed at the final
directory rename with `EPERM`. A native Windows reader holding a file without
delete sharing reproduced the same error three times; releasing that handle made
the same rename succeed each time. Holding the working directory in a separate
process instead produced `EBUSY`, also three times, and releasing it restored the
rename. These establish unsafe directory-renaming assumptions; the user's log
does not identify the actual handle owner, so no particular scanner is blamed.

The native held-file regression failed with the exact `EPERM` before the fix.
Version directories are now allocated at their permanent unique path before
copying/building. Validation still precedes activation, which changes only the
launcher selection file. The regression verifies activation and launch while the
reader remains alive. Existing installations and common launchers are compatible.
Cleanup is restricted to the attempt's owned, unselected directory; the selected
version cannot be removed. A cleanup error retains unselected files and does not
prevent releasing the installer lock or mask the original failure.

All eight focused installer tests passed on Node 25.8.1 and Node 24.22.0, including
the native held-file regression, selected-version deletion refusal, foreign-token
refusal and the existing snapshot/data/CLI/interactive-cancellation checks. Type
checking, JavaScript syntax and whitespace checks passed. The red regression log
and final runtime logs are ignored under `.grampus/` as
`installer-lock-regression-red.log`, `installer-lock-final-node25.log` and
`installer-lock-node24.log`.

A complete update through the existing installed command succeeded with a native
reader holding the candidate's README before and during activation. The old
selection remained current when the reader acquired its handle, the
new version launched afterward, task history survived and an open old dashboard
retained its original build. A second full trial deliberately failed compilation
while the same kind of reader prevented cleanup: the selected version and stored
task remained intact, the unselected directory was reported as retained and
`install.lock` was released. These trials used isolated retained journals and no
model inference. The reusable driver is retained under the explicitly marked
ignored `.grampus/installer-debug/` directory.
The resulting installed distribution also passed the Node 24.22.0 CLI, report,
native process identity/supervision, dashboard asset and packaged-worker smoke
(`installer-lock-smoke-node24.log`). The broader controller suites were not repeated
for this packaging-only correction; their preceding results are recorded below.

## Local Windows installation and updates — 18 October 2026

The per-user installer was exercised against a real destination outside the source
checkout. It installed locked dependencies into a copied source snapshot, built
there, pruned development dependencies and activated a version through the common
launcher. The real `grampus.cmd` reported the installed version and build from an
unrelated working directory. No source `dist` or `node_modules` was used by the
installed application.

An installed-copy smoke trial exercised relative CLI brief paths, persisted approval
and reporting, native process identity, the real Windows supervised check runner,
all three dashboard assets and the packaged UI worker. The worker prepared an
actual guided Git worktree and reached `awaiting_scope` with supplied source text.
The same installed-distribution smoke also passed on Node 24.22.0, including the
packaged native helpers and UI worker (`installer-installed-smoke-node24.log`).
No providers or model inference were used by these smoke operations. External
provider installation checks used only their version commands.

Updating through the installed `grampus update --yes` selected a new version while
an already running dashboard continued reporting its original build. The same
journal retained its stored task. A second update from an isolated source copy
containing invalid TypeScript failed compilation; the selected working version,
stored task and old dashboard were unchanged. The trial retained logs and result
JSON outside the checkout; its invocation scripts and installation pointer are
ignored under `.grampus/`.

The actual per-user installation also registered its `bin` directory once in user
PATH and launched by command name from an unrelated directory. Installed and
development dashboards ran simultaneously on their default ports 4317 and 4318,
with separate journals and the correct mode/version metadata. Checkout source
edits did not replace installed files. The development batch launcher is named
`Grampus-Dev.cmd` to avoid Command Prompt's current-directory lookup shadowing the
installed command.

Offline installation tests cover version/destination rejection, copied-source
independence after deleting the fixture checkout, version switching and failed
activation, data retention, argument/current-directory preservation, explicit data
overrides, bare dashboard startup, missing prerequisites, prompt cancellation and
concurrent installer refusal. Prompt cancellation simulates a terminal input flag;
native terminal interaction is not established by that test. The execution tool's
PTY launch was unavailable in this environment, so full real installation/update
trials used explicit `--yes`. No GUI installer or bundled Node runtime was added.

The first complete default-parallel Node 25.8.1 suite passed all 241 then-existing
tests without failures, cancellations or skips (613.8 seconds). Adding the prompt
test exposed a Windows `--import` fixture path error, fixed by supplying a file URL.
The first Node 24.22.0 full run recorded 240 passes and two failures: that fixture
error and an existing timeout test's PID-only liveness assertion after confirmed
native settlement (632.8 seconds). The unchanged timeout test passed in isolation.
PID reuse is a plausible cause given the earlier measured Windows behavior; the
failed run did not preserve an OS creation time proving the cause. The timeout
fixture now observes both original process creation times while alive and checks
those identities after termination, with time for the observations before timeout.
It still requires a real timeout, confirmed tree shutdown and released ownership;
no production process/recovery guard changed. All eight focused installer/timeout
tests then passed on Node 25.8.1 (13.4 seconds).

The final complete default-parallel Node 24.22.0 suite passed all **242 tests**,
without failures, cancellations or skips (618.3 seconds). The final focused Node
25 run includes the corrected prompt fixture and stronger timeout identity check;
the earlier complete Node 25 run covered the other unchanged implementation paths.
Full runtime suites ran sequentially. Logs are retained under ignored `.grampus/`
as `installer-full-node25.log`, `installer-full-node24.log` (initial failures),
`installer-final-focused-node25.log` and `installer-final-full-node24.log`.
Type checking, installer/launcher/browser JavaScript syntax and whitespace checks
also passed. These are local packaging/controller trials with offline replies;
ordinary-project provider trials, release-wide independent review and wider native
terminal/browser coverage remain release work.

## Reverse pairing, Orca multi-file delivery and live crash recovery — 18 October 2026

On Windows with Node 25.8.1, the multi-file pilot passed these additional live paths:

- Claude (`claude-opus-5-5`) implementation → Codex (`gpt-6.1-sol`) review in a
  standalone workspace. Both files changed, the oracle passed, the caller inspected
  the output and recorded simplification, review returned no findings, acceptance
  passed and a verified local commit completed the task.
- Codex implementation → Claude review in a local Orca-created workspace. The same
  gates and local commit delivery passed, with the stable Orca identity retained.
  Review preserved the earlier nonblocking suggestions about numeric overflow and
  broad exception handling; no requirements were silently expanded.
- Live Claude controller loss during editing, once standalone and once in a local
  Orca workspace. The observer saw `summary.cjs` change and killed only its owned
  controller while its implementation lease was active. The supervisor stopped the
  process tree and wrote an `interrupted` terminal receipt. A fresh CLI recovery
  process preserved the changed library and unchanged CLI, released ownership and
  left the task stopped, with no new implementation run, authorized tools,
  completion evidence or commit. Orca inspection also verified the original instance.

The interrupted tasks deliberately remain incomplete. Recovery did not resend the
prompt, reset files or create a new attempt. Local evidence lives in ignored fixture
journals, reports, `result.json` and `recovery.json`; Orca fixture workspaces are
retained, including the partial edit. These runs do not establish Codex-specific
mid-edit crash recovery or post-recovery task completion. Existing offline fixtures
cover generic process/receipt recovery; the new offline pilot test exercises the
observer and a separate CLI recovery process with a real supervised fixture tool.
All 155 offline tests passed. The four focused pilot tests also passed after adding
the stricter no-new-provider-activity assertion. Inspection of both saved live
recovery journals confirmed zero new turn/process/tool activity and no scope errors.
The latest build and whitespace checks passed. Other platforms and Node 24 were
not rerun for this slice.

## Multi-file standalone pilot — 18 October 2026

The new `npm run probe:multifile -- --live` passed on Windows with Node 25.8.1.
Codex (`gpt-6.1-sol`, observed default) edited `summary.cjs` and `cli.cjs` using
authorized native patches under the existing process supervisor. The independent
oracle exercised empty/single/mixed/negative inputs, unchanged input arrays,
invalid library values, CLI argument count/JSON syntax, exact stderr and exit codes.

After regression validation and submission, the process exited at a durable
checkpoint. The caller inspected both generated files and the oracle and recorded
a concrete simplification assessment. A separate invocation then obtained a fresh
Claude (`claude-opus-5-5`, observed default) review, passed saved-oracle acceptance
and made a verified local fixture commit. The task reached `complete`; the fixture
branch was not pushed. Journals, report, assessment and result remain under ignored
`.grampus/task-probes/`.

The reviewer raised no blocking findings and retained two suggestions: define how
finite inputs whose sum overflows should behave, and reconsider the broad CLI catch
if the library grows. Aggregate overflow behavior is not specified by this pilot.
This result establishes a bounded two-file task, not broad numerical coverage or
unattended scheduling. The reversed provider pairing, multi-file Orca path and live
mid-task interruption have not been exercised by this pilot.

Three added offline tests establish that the oracle rejects the incomplete baseline
and a library-only implementation, accepts a complete implementation, and detects
input mutation, numeric coercion, ignored extra arguments, wrong error streams and
wrong exit status. CLI tests reject missing live opt-in and incomplete continuation
arguments before creating a task or starting inference.
All 154 offline tests passed on Node 25.8.1. The focused tests also passed after
adding rejection of an empty continuation id; type checking passed. A second finish
invocation against the completed live journal was refused before any new review or
delivery. Node 24 and other platforms were not rerun for this slice.

## Original discovery

Observed on Windows on 17 October 2026. This records narrowly verified facts;
installation and authentication are not proof of working inference or task delivery.

| Component | Installed version | Verified locally |
| --- | --- | --- |
| Node.js | 25.8.1 | Compiled controller, SQLite transactions, CLI and behavioral tests |
| Git | 2.55.0.windows.5 | Executable discovery; checkout had no commits at the time of the initial probe |
| Codex | 0.162.1 | Spawn app-server over stdio, initialize/initialized handshake, account/read returning ChatGPT authentication, close process |
| Claude Code | 2.1.300 | CLI discovery and auth status reporting a signed-in first-party Claude account |
| Orca | 1.4.229 | Version-matched CLI guide and current worktree discovery from a Node child process |

Validation outcome: all 27 tests passed on Windows using both the installed Node
25 runtime and a Node 24 runtime fetched with `npm exec --package=node@24`.
`npm run demo`, standalone discovery, and discovery with `--orca` also passed.
The suite includes a child controller exiting without closing its database,
reopening state, stale version/attempt rejection, evidence gates, stop confirmation,
transaction rollback, subprocess timeout/EOF handling, and CLI persistence.

Run `npm run doctor -- --orca` to repeat discovery. The command prints only selected
authentication metadata, not email, organization identity, tokens or raw provider
logs. Run without `--orca` for the standalone discovery path.

An initial Orca probe timed out because its piped stdin remained open. Closing stdin
for commands with no input fixed the probe. A child-process test now covers EOF
delivery. Interactive JSON-RPC keeps stdin open until shutdown.

## Initial architecture findings

These were the first slice's findings; the live-session results below supersede
its statements about unverified conversational capabilities.

- Grampus owns approvals, workflow state and evidence. The database lives outside
  task worktrees. A workspace host owns its worktree lifecycle. Runtime adapters
  must make execution ownership explicit before launching work.
- Codex's application integration can use its documented app-server protocol.
  The local handshake is verified; questions, streaming turns, interruption,
  resumption and model usage are not verified yet.
- Claude's documented programmatic output provides session and result events.
  The installed CLI exposes streaming input/output and resume flags. Actual event
  handling and interruption on Windows still need a live probe.
- Orca's installed CLI supports workspace lookup and agent launch. Its launch
  interface can choose a chat or terminal. Supported structured session control
  and evidence access still need validation; do not infer them from terminal input
  acceptance or a returned agent handle.
- Keep API access disabled unless explicitly selected. Discovery performs no
  inference and does not modify authentication. Usage in controller reports remains
  unknown until real provider evidence is available.

## Still required for the first real-task milestone

1. The supplied-text conversational path now passes for both providers. Integrate
   that path into task kickoff and review, with repository context and task versions.
2. Graceful interruption, owned process exit and session resumption now pass live.
   Extend lifecycle validation to repository tool processes and abrupt live-provider
   failure; the offline suite currently covers controller crashes and stale results.
3. Create an isolated Git worktree, implement a small change, run real checks, obtain
   a fresh independent review, resolve findings and commit the slice.
4. Repeat through Orca-managed workspaces with a single execution owner. Do not
   schedule the same work through both Grampus and Orca.
5. Run compatibility checks on macOS and Linux. Windows success alone does not
   establish portability. Installer distribution is also unverified.

The first slice's automated suite exercises real SQLite persistence and subprocess
lifecycle, plus simulated workflow evidence. Grampus has not yet implemented a
real repository task, and its own implementation has not had independent review.

## Live-session evidence, 17 October 2026

Both `npm run probe -- codex` and `npm run probe -- claude` passed on Windows.
Each live turn ran in a separate controller process and reused the exact saved
provider session id. Probe prompts contained only test fixtures.

| Capability | Codex | Claude |
| --- | --- | --- |
| Subscription authentication before inference | ChatGPT | Claude Team |
| Observed model | gpt-6.1-sol | claude-opus-5-5 |
| Structured question and later answer | Passed | Passed |
| Context retained after controller/process restart | Passed | Passed |
| Blocking review finding on supplied arithmetic bug | Passed | Passed |
| Requested interruption and owned process exit | Passed | Passed |
| Resume after interruption, recall earlier answer | Passed | Passed |
| Token usage snapshot | Reported cumulative totals | Reported cumulative model totals |
| Cost | Unknown | Provider estimate; billed cost unknown |

Codex used installed app-server 0.162.1. Claude used the bundled executable from
Agent SDK 0.3.302, rather than the separately installed CLI 2.1.300. An initial Claude
preflight failed because the SDK omitted `tokenSource` while reporting `firstParty`
and `Claude Team`. The check now recognizes that observed subscription metadata;
API-key, unknown and gateway authentication remain rejected and covered by tests.

The probes validate the structured conversation protocol. They do not validate
native provider question tools, arbitrary tool-process cancellation, repository
editing, independent review of Grampus itself, or Orca-owned agent execution.
Questions and review results are supplied-text fixtures and do not complete tasks.

The expanded offline suite also tests a real controller subprocess exiting with
an unsettled session, confirmed dead-process recovery, duplicate ownership,
schema 1 migration, out-of-order Codex events, interrupted completion races,
malformed replies, deadlines, and uncertain shutdown. Platform claims remain
limited to Windows until macOS and Linux checks run.

Final validation for this slice: **45 tests passed on Node 24.22.0 and 25.8.1 on
Windows**, plus both live provider probes. No independent review of the Grampus
implementation has been performed.

## Standalone workspace validation

The expanded suite passed **57 tests on Node 24.22.0 and 25.8.1 on Windows**, using Git
2.55.0.windows.5. Twelve additional tests use real temporary repositories and cover:

- Locked worktree creation at a pinned commit while preserving dirty source files.
- Approval/version checks, synthetic-task refusal, invalid/nested destinations.
- Competing controllers, durable reservations and no automatic replay after failure.
- Successful recovery after an actual controller exits inside the ready transaction.
- Unknown/live process refusal, host checks and preservation of dirty recovery state.
- Ownership-lock mismatch, stale task versions, CLI restarts and schema 2 migration.

Native path canonicalization was required to match Git and Node paths on Windows,
including short/long directory aliases. Fixture Git configuration fixes line endings
locally without changing the user's Git configuration. Live provider probes were not
repeated because this slice does not change either provider adapter. Orca workspaces
were not validated in this standalone slice; see the subsequent evidence below.

## Orca workspace validation

**66 tests passed on Node 24.22.0 and 25.8.1 on Windows.** Nine additional tests cover
Orca protocol validation with real temporary Git repositories: host-chosen names,
pinned bases, lost replies, missing/duplicate/truncated discovery, instance changes,
dirty recovery, compatibility/approval gates, shared reservations and schema 3 migration.

Installed Orca **1.4.229** was checked against its bundled `orca-cli` guide and command
help. A live creation probe confirmed the response includes a full worktree id,
stable local instance identity and exact base ref. Orca controls its branch naming;
the adapter records the observed name rather than predicting it.

The Grampus adapter then created a live worktree with an approved fixture brief,
explicit base commit, no agent request and Orca setup skipped. Its successful create
reply was deliberately discarded at the adapter boundary. A separate controller
reopened the journal, discovered the exact request marker, verified the clean pinned
checkout, and reached `ready` without replaying creation. Both clean probes were
removed through Orca after checking their default terminals were unused shells.
Local journals and identities remain ignored; no personal paths are included here.

This validates local Orca checkout creation and recovery, not agent execution leases,
host-operation cancellation, arbitrary tool-tree supervision, remote hosts or task
completion. Provider inference probes were not repeated. Independent review of the
Grampus implementation and macOS/Linux validation remain outstanding.

## Linked-session ownership validation

**85 tests passed on Node 24.22.0 and 25.8.1 on Windows.** The ownership tests use real
temporary Git repositories, SQLite journals, separate controller processes and
provider/Orca protocol fixtures. They verify:

- Atomic task/attempt/session preparation and rollback of nested journal writes.
- Approved prompt context, questions across restarts, and observed model identity.
- Exclusive ownership between review sessions and concurrent independent workspaces.
- Lease release only after confirmed shutdown, with stale results unable to release
  a newer run's ownership.
- Real controller-crash recovery after both recorded PIDs exit; unknown startup/PIDs
  retain the lease without replay.
- Interruption racing with success, malformed replies and workspace inspection
  failure before provider dispatch.
- Orca instance replacement, legacy unlinked sessions, stale bindings, review fallback,
  idle closure, CLI persistence and schema 4 migration.

A regression test reproduced a startup cancellation gap: an unresolved connector
without an observed PID was previously treated as stopped. The runner now tracks
pending startup explicitly and retains recovery state. A connection arriving late
is closed without receiving the prompt. This is covered without live inference.

Live provider and Orca probes were not repeated for this slice. The new ownership
behavior is verified with process/protocol fixtures, not an end-to-end repository
coding task. At that checkpoint, tool-process supervision and artifact/check execution
remained outstanding; the subsequent slice below adds an explicit Windows check path.
Shared worker budgets, independent review of Grampus and macOS/Linux validation remain
outstanding.

## Repository check and submission validation

**101 tests passed on Node 24.22.0 and 25.8.1 on Windows.** Sixteen new tests use real
Git worktrees, SQLite journals and Windows subprocesses, plus injected outcomes for
transaction/uncertainty boundaries. No live provider inference or live Orca operation
was needed for this slice.

- A fixture greeting change is checked by executing the real script and asserting
  exact output. The check retains old/new content, output, exit status and process
  identities. Explicit submission passes validation while other completion gates
  continue to block the task.
- Snapshots distinguish index changes, nonignored untracked files and inherited rules;
  ignored generated output is excluded. Stale content/instruction digests prevent
  dispatch. Unsupported submodules and invalid command options are refused.
- Nonzero exits, repository-changing commands and newer failed checks cannot be
  presented as passed validation. Submission rechecks the artifact, and a journal
  failure rolls back both implementation success and evidence.
- Check, conversation and closure operations compete for the same durable lease.
  Intent is present before dispatch. Unknown shutdown persists across reopening and
  cannot be cleared through conversation recovery.
- Real timeout and cancellation terminate tools. A tool leaving a detached child
  receives a failed result, even with exit zero; its descendant is terminated.
  Excessive output stops the job and retained diagnostics are bounded.
- Killing the controller closes the supervisor's input and terminates its job, while
  leaving the journal lease held. Killing the supervisor also terminates the job but
  never manufactures exit confirmation. Unicode and shell-like argument strings
  round-trip literally, and a failed executable launch is recorded.
- CLI snapshot/check/show/submission works across separate processes without inference;
  schema 5 migration preserves existing execution records.

These checks establish the Windows helper's ordinary child-process behavior, not a
sandbox or supervision of work delegated to services, WMI or external agents. Command
selection and acceptance coverage are still trusted caller choices. Snapshot/check
recovery, artifact-aware review and post-submission revalidation were addressed in the
subsequent slice below. Provider-driven edits, other-platform supervision and a complete
independently reviewed live task remain to do.

## Recovery and artifact-gate validation

**112 tests passed on Node 24.22.0 and 25.8.1 on Windows.** Eleven additional tests and
extensions to the earlier tests cover receipt recovery and artifact-bound gates. Review
responses are injected protocol fixtures; no new live model call or Orca operation was
performed. Existing live provider evidence above still describes conversation probes.

- An actual controller is terminated while its tool tree is running. The surviving
  supervisor stops the job and writes a terminal receipt, and a separate CLI recovers
  the lease without replaying or accepting success. A second recovery is rejected.
- Live owners, mismatched receipt ids/tokens/PIDs, unconfirmed settlement and missing
  receipts cannot release ownership. A lost final reply with a valid receipt can be
  reconciled, after which a fresh check runs explicitly.
- Crashes before dispatch and during read-only snapshot collection are recoverable
  under their own protocol. Read-only recovery cannot clear command ownership. Schema
  6 migration preserves uncertain older records without fabricating proof.
- Review receives the approved brief, instructions, full bounded source and verified
  digest. It records an independent reviewer identity only after shutdown and a fresh
  content check. Stale content blocks inference; changes during a review prevent pass.
- Blocking findings fail the gate; questions can resume with answers; unknown shutdown
  retains the lease. A newer pending/failed/skipped review cannot expose an older pass,
  including same-provider fallback with an explicit reason.
- Acceptance checks require exact approved criteria and expected stdout. Exit zero
  with wrong or unavailable output fails; changed submitted artifacts cannot dispatch.
  Recovery of a lost verification records skipped evidence rather than resurrecting an
  earlier pass. CLI verification is exercised across separate controller processes.
- The fixture reaches completion only after real validation, a mocked independent
  review, a real exact-output check and an explicit fixture simplification assessment.
  Missing gates and later repository changes block completion.

The crash test initially exposed that libuv's normal Windows child ownership kills
the native helper with its controller, before a receipt can be saved. Direct detached
Windows PowerShell did not provide the required process behavior. The implementation
now uses a hidden detached Node host owning a normally launched hidden PowerShell
helper. Pipe closure stops the native job, broken-pipe output is drained, and host/native
deadlines bound lifetime. A hard host/helper loss without a receipt still retains
ownership. The successful crash regression verifies the implemented process arrangement.

These results do not constitute independent review of Grampus itself, a live full-task
run, cross-platform process supervision or a proof that a caller's acceptance plan is
semantically sufficient. Larger/binary repository reviews, native provider edits,
review arbitration, general slice delivery and the simplification UI remained work
at that checkpoint. The next slice below adds the assessment API and a bounded pilot.

## Explicit simplification and live standalone task

Observed on Windows on 17 October 2026 using Node 25.8.1, Git 2.55.0.windows.5,
Codex CLI 0.163.0 with ChatGPT authentication and Claude Code 2.1.300 with first-party
subscription authentication. `npm run build` and `npm run probe:task -- --live` passed.

The pilot created a standalone fixture worktree, approved changing `hello` to
`hello world`, and obtained the replacement statement from live Codex (`gpt-6.1-sol`).
The controller checked the response against a single-statement allowlist before
writing it. A real Node regression executed the changed program and asserted exact
output. Submission, explicit simplification assessment and fresh live Claude review
(`claude-opus-5-5`, no findings) passed. A separate acceptance command executed
`greeting.js`, matched `hello world` plus one newline, and completion verified all gates.
Observed model names are defaults from this run, not fixed product presets.

The probe made a local fixture commit with the existing configured personal Git
identity, verified its greeting content and clean status, journaled delivery, and
rendered a task report. Journals, output, provider transcripts, report and fixture
repositories are retained locally under ignored `.grampus/task-probes/`; no personal
paths or raw transcripts are included here. The fixture branch was not pushed.

The full offline suite passed 114 tests on both Node 24.22.0 and 25.8.1. New coverage
includes explicit assessment outcomes, stale code/instructions superseding older
passes, role/state validation, CLI persistence and an actual controller exiting
during reassessment followed by read-only recovery that leaves the gate pending.

This demonstrates a small live task with controller-applied code and independent
review, not native provider editing or review of Grampus itself. The full pilot did
not exercise Orca or a mid-task crash. Its post-completion commit changes HEAD/index;
general commit binding, interruption recovery and delivery integration remain work.

## Supervised local delivery and recovery

On 17 October 2026, the standalone live pilot passed again using the new delivery
service: Codex `gpt-6.1-sol` supplied the allowlisted greeting change and Claude
`claude-opus-5-5` reviewed its verified snapshot with no findings. Real regression
and exact-output acceptance passed. The supervised worker staged and committed the
change; the controller verified the commit, index, working content and instructions
before atomically recording delivery and task completion. The configured personal
Git identity was preserved. No fixture branch was pushed.

The full offline suite passed 127 tests on Windows with Node 24.22.0 and 25.8.1.
Thirteen delivery tests cover exact bytes including binary/add/delete operations,
executable mode preservation, identity, CLI delivery, stale/missing gate rejection,
Git line-ending conversion refusal, hook changes, timeout, missing receipts,
controller exits before dispatch and after commit, mismatched content and replaced
commits during recovery, completion/journal rollback and migration from schema 7.
Gate evidence in these delivery tests is explicitly supplied by trusted fixtures;
the live pilot supplies separate provider integration evidence.

The post-commit crash test leaves the task awaiting verification and the lease
retained. A fresh CLI controller checks the terminal supervisor receipt and exact
existing commit, completes the task, and verifies that history still contains only
the baseline plus one delivery commit. Pre-dispatch recovery invokes no Git writes.
Absent receipt proof leaves ownership blocked. A settled command with changed
content or an unexpected commit cannot complete the task.

Schema 8 retains the submitted snapshot and maps its original digest to the accepted
commit. Git hooks/signing/configuration remain active. This strict initial path rejects
normalization that changes reviewed raw bytes and preserves failed staging/commits
for investigation; there is no automatic rollback, amend, lock removal or retry.
Only standalone Windows delivery is supported. Native editing, Orca delivery,
multi-slice scheduling and cross-platform supervision remain unimplemented. The full
live pilot was not interrupted; crash recovery uses real Git with offline evidence.
Grampus itself still has not had independent review. Local journals/reports and
provider transcripts remain ignored and are not committed.

## Native Claude editing and independent Codex review

On 17 October 2026, `npm run probe:task -- --live --native` completed on Windows
with Claude `claude-opus-5-5` implementing the greeting through authorized native
Read/Edit tools and Codex `gpt-6.1-sol` reviewing the resulting artifact with no
findings. The controller did not apply a model-produced source string. Real
regression, exact-output acceptance and verified local delivery passed, producing
a local fixture commit and journal-derived report. Neither fixture branch was pushed.

The first run changed the intended file but failed before completion: the SDK invoked
its internal StructuredOutput tool and the initial file-only hook denied it. The
failed run and its edit were preserved. The adapter now accepts that formatting tool
only after validating the reply schema; a fresh explicit run then passed. No automatic
inference retry or failure-to-success rewriting occurred. Offline tests cover both
valid and malformed formatting requests.

All 137 offline tests passed on Windows with Node 24.22.0 and 25.8.1. Native editing
tests use explicit fixtures, not live provider inference. They exercise scope and
tool decisions, hard links, malformed/oversized inputs, journaling failure, state
and provider restrictions, questions, uncertain shutdown and schema 8 migration.
An actual controller-kill fixture waits for a supervised tool to change a file, kills
its controller, confirms terminal receipt and supervisor exit, and recovers as
interrupted with the partial edit intact. Recovery neither repeats the write nor
accepts implementation success. Pre-dispatch recovery invokes no tool.

The live provider run itself was not interrupted. At that checkpoint the mode was limited to Claude,
standalone Windows workspaces and existing UTF-8 files. It is an application tool
policy, not an OS filesystem sandbox; external edits can race path checks. Native
Codex editing, Orca editing, shell tools and wider file operations remained disabled.
Grampus itself has not had independent review. Operational paths, journals, provider
transcripts and fixture repositories remain local and ignored.

Implementation references: Claude [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
and [permissions](https://code.claude.com/docs/en/agent-sdk/permissions). OpenAI Docs
skill guidance was used to inspect [Codex app-server approvals](https://learn.chatgpt.com/docs/app-server)
for the future adapter; no Codex editing permissions were enabled in this slice.

## Native Codex editing and independent Claude review

On 17 October 2026, `npm run probe:task -- --live --native-codex` passed on Windows
using Codex app-server 0.163.0 (`gpt-6.1-sol`) and Claude `claude-opus-5-5`. Codex
changed the greeting through a journaled native apply_patch approval. Claude reviewed
the captured artifact with no findings. Real regression, explicit simplification,
exact-output acceptance and supervised verified local delivery passed. A second
explicit fresh pilot also passed after adding returned-policy checks for the
read-only sandbox and client approval routing. No fixture branch was pushed.

The implementation follows the official [app-server approval flow](https://learn.chatgpt.com/docs/app-server)
and the installed generated schemas, including the snake-case `move_path` update
field and the meaning of `grantRoot`. Each request is bound to a pending patch in
the active thread/turn. Only approved existing file updates receive a one-item
acceptance, after journaling. Root/session grants, repeated requests, additions,
deletions, moves, commands and other permission requests are rejected. The worker
supplies editable text in the prompt, so no shell read tool is required.

All 144 offline tests passed on Windows with Node 24.22.0 and 25.8.1. Seven new tests
cover whole-patch validation, journaling failures, shared Codex lease/settlement,
stale/foreign/repeated approvals, interruption and server/client RPC id collisions.
The existing controller-death, process-tree and receipt recovery tests still pass;
these use fixture tools. The live provider pilots were not interrupted and only
changed a one-line greeting. Orca editing/delivery, wider file operations and other
platforms remain unverified. Grampus itself still has not had independent review.
Generated schemas, operational paths, journals, transcripts and fixture repositories
remain ignored local evidence.

## Local Orca native editing and verified delivery

At the 18 October 2026 checkpoint, `npm run probe:task -- --live --native-codex --orca`
passed on Windows with Orca 1.4.229. The pilot registered an isolated fixture
repository, created a worktree through Orca and pinned its stable local instance.
Codex `gpt-6.1-sol` performed an authorized native edit; Claude `claude-opus-5-5`
reviewed the captured artifact with no findings. Real regression, explicit
simplification, exact-output acceptance and supervised verified local commit
delivery passed. The configured personal Git identity was preserved; no fixture
branch was pushed.

The installed version-matched `orca-cli` guide, CLI help and agent command schema
were inspected. They expose worktree lifecycle and identity operations but no Git
commit command. This slice keeps Orca authoritative for its workspace lifecycle
and runs ordinary staging/committing inside Grampus's Windows Job Object. Provider
processes also remain Grampus-owned; this does not exercise Orca agent-launch,
terminal coordination, remote hosts or Orca-host mutation cancellation.

All 42 targeted tests passed. All 151 offline tests also passed on Node 24.22.0 and
25.8.1. New fixtures cover both native providers in Orca workspaces, replaced/archived
instances before and after edits, worker-side identity checks before staging and
commit, altered durable bindings, post-commit replacement, and lost-reply recovery
with a real supervisor receipt. Recovery accepts only the original instance and
existing exact commit, without writing again. These are simulated Orca identity
responses around real temporary Git repositories and supervised processes.

The initial overlapping full-suite runs passed all tests on Node 25 but produced
two Node 24 fixture failures: an existing controller-crash recovery refused a PID
as live/unverifiable, and an Orca lost-reply test recovered an interrupted writer
instead of the successful write that fixture expected. Both passed in isolation;
the Node 24 full suite then passed when run separately. The lost-reply test now
asserts the writer's result before testing adoption, so future failures expose the
underlying settlement outcome. No timeout, PID guard or receipt requirement was
relaxed. The original failures' exact cause remains unconfirmed; retained local logs
record them, and complete runtime suites should be run sequentially.

After the live task, its exact instance, clean checkout, retained commit and absent
Grampus lease were verified. The default Orca terminal contained only an unused
PowerShell prompt. The fixture worktree was removed through Orca without force;
subsequent listing and filesystem inspection confirmed removal. Its repository
registration, commit, journal and report remain local. Operational paths and fixture
data are ignored and not committed.

The live task remains a one-line greeting and was not interrupted mid-turn. Broader
tasks, live-provider recovery, Orca-managed session coordination and independent
review of Grampus itself remain outstanding. External editors and separately launched
Orca agents are not fenced by a Grampus journal lease.

## Exact native file creation — 18 October 2026

The native policy now has an optional `create` list separate from existing `files`.
Offline fixtures cover creation-only policies, overlaps and protected/device paths,
missing parents, junctions, hard links, ignored files, previously deleted tracked
paths, malformed/oversized text, whole-patch rejection and failed decision journaling.
They exercise Claude Write followed by Read/Edit and Codex add followed by update.
Real controller-loss fixtures preserve a partially created file, require the
supervisor receipt, release ownership only on explicit recovery and never replay
inference or manufacture task completion evidence.

The repeatable pilot adds `--create-library`, starting without summary.cjs while
retaining the independent behavioral oracle and manual simplification checkpoint.
A live standalone Codex implementation created that exact path and changed cli.cjs.
After code/oracle inspection, explicit simplification, fresh Claude review and saved
oracle acceptance, supervised delivery committed the exact new file and completed
the task. The reviewer retained one nonblocking aggregate-overflow suggestion;
the brief does not specify aggregate overflow behavior. Observed models were
gpt-6.1-sol and claude-opus-5-5. No push occurred, and operational data remains
under the ignored task-probe directory.

The reverse standalone pairing also passed: Claude created summary.cjs and changed
cli.cjs, the saved oracle passed, an explicit simplification assessment was recorded,
and fresh Codex review returned no findings. Acceptance and exact local delivery
completed the task with the new file in the verified commit. Both creation pilots
retained their fixture workspaces and journals. Creation in Orca workspaces uses
the shared implementation path but has not had a separate live creation pilot.

The full offline suite passed all 165 tests, with no skips, on Windows with Node
25.8.1; the focused implementation/Codex/pilot suite passed 34 tests. The original
155-test baseline also passed before changes. `npm run doctor` confirmed installed
Git 2.55.0.windows.5, Codex CLI 0.163.0 with ChatGPT authentication and Claude Code
2.1.300 with first-party subscription authentication. New creation coverage has
not been rerun on Node 24, macOS or Linux. Neither Grampus implementation changes
nor their tests have received independent review; live review covered fixture output.

Creation retained the existing Windows process supervisor and schema 9 journal
contracts, requiring existing parent directories. The next slice below adds file
deletion. Directory creation remains disabled. File policies are provider controls,
not an OS sandbox.

## Exact file deletion — 18 October 2026

Policies now accept separate `delete` paths, disjoint from existing edits and
creations. Targets must be bounded regular UTF-8 snapshot files with unchanged
bytes. Codex's existing item approval authorizes only the complete scoped patch.
Claude gets a single controller-owned in-process SDK tool when deletion is requested;
the handler checks its owning active turn, exact scope and journal before unlinking
and records `tool.deleted` after success. Shell and external MCP remain disabled.
Zod is pinned directly at the version already installed as the SDK's peer dependency.
The implementation follows the SDK's [custom-tool contract](https://code.claude.com/docs/en/agent-sdk/custom-tools)
and [permission hooks](https://code.claude.com/docs/en/agent-sdk/hooks), checked against
the installed TypeScript definitions and live SDK behavior.

The baseline passed 165 tests before edits. The final complete offline suite passed
178 tests with no skips on Windows, Node 25.8.1. Focused provider/implementation checks
passed 39 tests, and the pilot suite passed 7. Coverage includes stale bytes, policy
overlaps, unknown options, failed journaling, untracked/empty files, links, directories,
inactive SDK callbacks, actual controller loss after unlink, receipt recovery and
saved-oracle rejection of empty or directory replacements. One initial oracle-test
failure was fixture cleanup using rmSync on an empty directory; cleanup now uses
nonrecursive rmdirSync while the directory-replacement assertion remains intact.

Live standalone Claude → Codex and Codex → Claude pilots combined an edited CLI,
created library and removed obsolete tracked file. Both passed saved behavioral and
deletion checks, explicit inspected simplification, independent review, exact-output
acceptance and verified local delivery. Codex returned no findings on Claude output;
Claude retained two nonblocking suggestions on Codex output (unspecified aggregate
overflow and the CLI's broad catch). Observed models were claude-opus-5-5 and
gpt-6.1-sol. These reviews cover fixture output, not the Grampus implementation.

Separate live standalone Claude and Codex controller-loss pilots deleted the obsolete
file first, then were killed before implementing the missing library or changing the
CLI. Each supervisor produced an interrupted receipt; new recovery CLI processes
preserved the deletion and other file states, released the leases and left the tasks
stopped without new inference, completion evidence or commits. Evidence and all fixture workspaces
remain local under the ignored task-probe directory. No push occurred.

`npm run doctor` again confirmed Git 2.55.0.windows.5, Codex 0.163.0 with ChatGPT
authentication and Claude Code 2.1.300 with first-party subscription authentication.
The new deletion slice has not run on Node 24, macOS or Linux, or in a separate live
Orca pilot. Directory creation/removal and moves remain unsupported. No policy is
an OS sandbox, and concurrent external filesystem changes are still outside the lock.

## Explicit no-change delivery — 18 October 2026

`execution-deliver` accepts explicit `mode: no_change` and an explanation in its
message. It requires the same approved artifact, four gates and accepted decisions
as commit delivery. The worker compares raw HEAD/index paths, modes and blobs to
the checked files without staging or invoking commit hooks. Both worker and
controller verify snapshot stability; successful settlement records a no-change
outcome, null commit and the unchanged HEAD in the retained request.

Focused delivery and Orca suites each passed 18 tests on Windows, Node 25.8.1.
The final complete offline suite passed 184 tests with no failures or skips;
`npm run check` and `git diff --check` also passed. The final run additionally
checks no-change journal rollback and changed-index refusal during receipt recovery.
Coverage includes a real existing-greeting regression check, CLI delivery with a
failing commit hook, preserved index bytes, modified/deleted/untracked files,
staged-byte and mode mismatches, invalid modes, pending decisions, and refusal to
infer success from an empty commit request. A real controller exits after the
supervised no-change verification; a new recovery CLI accepts only the settled
receipt and original state, even with an index lock present. Missing proof or changed
HEAD/files/instructions refuses acceptance. Orca identity protocol fixtures run
the real supervised worker and reject archival at dispatch, acceptance and recovery.

These are offline fixtures; independent review/acceptance gate data in the delivery
tests is explicitly fixture evidence. No live provider or Orca-host pilot was run
for this slice. The next section adds multi-slice continuation; non-Windows
supervision remains work.

## Sequential approved slices — 18 October 2026

Optional ordered slice plans bind to the existing exact-version approval. Each
slice requires fresh gates and supervised delivery. Intermediate delivery records
its proof and readies a fresh attempt in the same workspace; the final slice verifies
every task criterion and requires integration review. Completion cannot bypass
planned deliveries. Schema 10 fences older controllers and preserves legacy tasks.

The original full suite passed 184 tests before changes. The focused slice/Orca
suite passed 25 tests, with no failures or skips, on Windows, Node 25.8.1.
Its two-slice greeting library/CLI fixture runs actual regression and exact-output
acceptance commands, explicit simplification, independent-session fixture reviews,
separate supervised commits and fresh CLI processes. The final check covers the
whole task, and a final-slice-only criterion mapping is refused.

The first complete post-change run passed 190 of 191 tests. The existing deletion
interruption pilot refused fresh-process recovery with `Supervisor is still alive
or unverifiable` after the observer had already read a settled receipt. That exact
case then passed alone. The cause is unconfirmed; PID reuse and transient process
observations remain possible. No PID/receipt recovery guard was changed.
The default parallel rerun passed 189/191, with the same conservative refusal in
the existing check-controller crash fixture and new-file interruption pilot. These
reported supervisor/controller liveness respectively; the new slice cases passed
in both runs. Full verification was then repeated with two test workers to reduce
concurrent process churn, rather than weakening liveness checks or ignoring tests.
That complete run passed all 191 tests with no failures or skips using
`node --test --test-concurrency=2 dist/test/*.test.js`. Type checking and
`git diff --check` also passed. The bounded run is validation of the whole suite;
it does not establish the cause of the default parallel failures or fix them.

Additional fixtures exercise real controller exits after commit and no-change
verification, receipt recovery in new CLI processes, exactly-once advancement,
pending decisions, failure/rollback, stale sessions/evidence, retry attempts on the
current slice, changed inherited instructions and external HEAD changes. Raw file
verification rejects a changed skip-worktree file even when ordinary Git status is
clean, and mode mismatches block continuation. Orca protocol fixtures use the real
supervised writer across both slices, retain the original instance/base and refuse
archival before starting the next slice. Only the identity RPC is simulated.

Reviews are offline fixtures, not live independent review of this implementation.
No new live provider or Orca-host pilot was run. Node 24, macOS and Linux have not
been run for this slice. No scheduler, arbitration, workspace rebinding, provider
permission changes or automatic replay was added.

## Live sequential task pilot — 18 October 2026

`probe:multifile -- --live --slices` splits the existing summary task into library
and CLI slices. Each has its own submitted artifact, skipped assessment template,
explicit simplification, other-provider review, saved-oracle acceptance and verified
local delivery. `--next <task-id> --db <journal>` explicitly starts the second slice
after delivery, retaining the original provider/model and approved brief. Intent is
journaled before execution creation, and finish continuation is fenced per execution.
Creation, deletion and interruption variants remain separate from sliced mode.

The standalone live Codex implementation → Claude review pairing completed both
slices with observed models gpt-6.1-sol and claude-opus-5-5. The first commit changed
only summary.cjs and left the CLI unfinished. A fresh Codex session then changed only
cli.cjs, preserving the delivered library blob. Both code/oracle inspections produced
explicit simplification assessments. Fresh Claude reviews passed each slice; final
acceptance repeated the library checks plus the complete command contract. The task
completed after two supervised commits under its original version-1 approval.

A separate journal/repository verification confirmed four distinct sessions and
exactly four provider turns, two implementation attempts, two independent reviews,
one workspace, the expected commit parent chain, a clean final checkout and no lease.
Acceptance mapped two library criteria in the first slice and all four task criteria
in the final slice. Repeating next-slice startup and both finish commands was refused,
with unchanged session/execution/task journals and no inference replay. Per-slice
assessments/results, receipts, the report and verification proof remain ignored under
the task-probe directory; no fixture repository was pushed.

Each Claude review retained one nonblocking suggestion about aggregate overflow:
finite inputs can sum to Infinity, which JSON serialization prints as null. The
approved criteria do not define aggregate overflow behavior; no additional criterion
or library change was inferred from the suggestion. Reviews cover generated fixture
code, not independent review of the Grampus implementation.

The focused pilot/slice suite passed 14 tests with no skips on Windows, Node 25.8.1.
After final replay-message refinements, all 8 pilot tests passed again, including
real controller-loss recovery in edit/create/delete fixtures. Oracle tests establish
that the library-only slice passes while the unfinished CLI still fails whole-task
acceptance. CLI tests refuse incompatible modes, foreign or premature task startup
and repeated next-slice intent before creating provider sessions. Build/type checking
and whitespace checks passed. The preceding 191-test full-suite result remains the
complete baseline; the full suite was not rerun for these pilot-only changes.

Doctor confirmed Git 2.55.0.windows.5, Codex CLI 0.163.0 with ChatGPT authentication
and Claude Code 2.1.300 with first-party subscription authentication. No separately
billed API access was enabled. Reverse pairing, multi-slice Orca-host execution,
Node 24, macOS and Linux were not exercised in this slice.

## Windows alpha recovery identity — 18 October 2026

The user selected a small Windows alpha before broader platform support; its scope
and release gates are recorded in [RELEASE.md](RELEASE.md).

The initial default-parallel baseline passed all 192 tests on Windows, Node 25.8.1.
That passing run does not invalidate the earlier intermittent liveness failures.
A short process-churn probe demonstrated actual PID reuse. A subsequent differential
probe recorded 12 instances in 168 process launches where the current process had a
previously retired PID and a different OS creation time. The previous PID-only check
would block all 12; creation-bound controller recovery accepted all 12 without
terminating any process. Raw observations remain under ignored `.grampus/`.

New workspace leases persist the controller's exact creation FILETIME as a decimal
string, and the native supervisor includes its creation time in terminal receipts.
Recovery can now distinguish replacement processes from live original owners.
Unknown/denied observations, malformed identities, mismatched receipts and live
owners still block. Old records without creation times retain PID-only recovery.
Recovery takeover replaces the controller creation time together with its PID.
No journal schema or receipt protocol version change is required. Ordinary
conversation and workspace-creation recovery keep their existing PID-only rules.

Two deterministic replacement-owner regressions failed before the fix. The six
identity tests now cover real OS observation, missing/unknown states, live and
replacement owners, legacy records, unavailable inspection, receipt binding and an
actual supervised receipt whose exact creation time matches its live observation.
The focused check/delivery/interruption-pilot run passed 55 tests, including real
controller exits and preserved existing/new/deleted files. This establishes the
PID-reuse failure mechanism, not that every historical liveness refusal had that
cause.

The default-parallel complete run passed all 198 tests on Node 25.8.1 without
failures or skips. The expanded pilot/identity follow-up passed all 14 tests,
including completing a recovered task through a fresh native implementation
attempt under the original version-1 approval. It refuses the stale execution,
preserves the interruption history, runs actual library/CLI validation and exact
acceptance, records explicit simplification and fixture other-provider review,
and delivers one supervised commit on the original baseline with a clean checkout.
Provider replies in that continuation are offline fixtures, not live inference or
independent review of Grampus itself.

The final default-parallel Node 24.22.0 run also passed all 198 tests without
failures or skips, including the expanded recovery-to-completion fixture. Runtime
suites were run sequentially. Build/type checking and `git diff --check` passed.
No provider inference, live Orca-host run or other-platform validation was performed
for this change. Existing process settlement, receipt matching and content/delivery
checks were retained. Diagnostic sources and the temporary regression build were
removed; local result logs remain ignored.

The process identity implementation uses Microsoft's documented
[Process.StartTime](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.starttime)
and preserves the exact [Windows FILETIME representation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).

## Guided foreground task workflow — 18 October 2026

The new task-level CLI connects the existing controller gates from an authored
JSON brief to verified local delivery. The complete normalized recipe and pinned
base are approved by digest. Exact file/instruction authorization and explicit
simplification remain checkpoints; provider replies never supply those approvals.
Foreground progression stops on questions, failed/skipped checks, blocking findings
and uncertain shutdown. Ordered slices retain independent gates and final whole-task
acceptance. No-change recipes run all gates without implementation inference.

A durable guided owner serializes active guided controllers in one journal. Intent
precedes every leaf call and records the original controller identity and known
result ids. Recovery checks the exact policy/command/delivery request and originating
lease before adopting an existing result. It starts no provider turn or Git write.
Cross-process stop requests reach the actual supervised tool through AbortSignal.
Explicit retry preserves files and uses a fresh execution/session and fresh gates.

The initial focused runs passed 9 workflow tests, then 4 control/question/sequential
tests. A newly injected failure in the guided journal after successful delivery
exposed discarded pending intent; that regression failed before the fix. The fix
retains intent/ownership when a leaf has returned or recorded results, even if the
subsequent guided update fails. That regression and a crash after entering an
assessment both passed in a two-test follow-up. Assessment input is persisted with
its artifact before execution, while a started assessment with no settled verdict
requires a new explicit assessment.

The default-parallel complete Node 25.8.1 run passed all 216 tests with no failures
or skips, including 18 new guided tests. They exercise actual supervised file writes,
regression/acceptance commands and Git commits; implementation and review replies
are explicitly offline fixtures. The cases cover CLI draft/approval/setup across
processes, stale authorization, review repair, implementation/review questions,
no-change delivery, global ownership, real tool interruption from another CLI,
unknown shutdown, sequential scopes and complete final acceptance, controller exits,
journal failure after commit, persisted assessment input, failed validation and
acceptance, and rejection of a corrupted result policy during recovery.

These are not live independent review of Grampus or a live guided project trial.
The existing live fixture pilots continue to demonstrate the underlying provider
and workspace integrations separately. Conversational kickoff, automatic repair/
arbitration, recipe rebinding, the browser interface and distribution remain work.
The walkthrough is [GUIDED-WORKFLOW.md](GUIDED-WORKFLOW.md), with a portable example
in [examples/guided-task.json](../examples/guided-task.json).

### Job settlement race found during Node 24 validation

The first complete Node 24.22.0 run passed 214/216. Two guided fixtures stopped
before assessment; their original assertions hid that earlier state. Adding
checkpoint assertions and a minimal real-process loop reproduced the underlying
supervisor issue: 2/40 zero-exit commands with no application children were reported
as `descendants_remaining`. Diagnostic observation at a higher frequency raised
that to 13/40. The root handle was signalled while the accounting count was one;
most subsequent PID-list snapshots were already empty. This demonstrates that an
instantaneous root-exit/accounting observation can falsely reject completed work.

The helper now observes job settlement for up to 100 ms after root exit, within
the original deadline and with cancellation active. Success still requires an
actual zero active-process count. Children surviving the window fail and are
terminated; final zero-count confirmation and receipt/ownership guards are retained.
No process is exempted by image name or PID. The accelerated 40-command loop then
passed all 40; after restoring the normal observation interval and removing every
diagnostic hook, the original 40-command loop also passed all 40.

A permanent 24-command regression plus real timeout, hanging-child and the two
affected guided cases passed all 5 focused tests on Node 24. Microsoft's
[job accounting contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
describes the retained-reference counter, and its
[job process-list structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
was used only for diagnosis.

The final default-parallel suites passed all 217 tests on both Node 24.22.0 and
Node 25.8.1 without failures, cancellations or skips after the settlement fix.
The runtime runs were sequential and took approximately 313 and 308 seconds,
respectively. They include 18 new guided tests and the new rapid-exit regression.
Build/type and whitespace checks also passed. Provider replies in these new tests
are offline fixtures; no live inference or new Orca-host trial was run for this
change.

## Local dashboard and conversational kickoff — 18 October 2026

The Windows developer checkout now has a functional browser interface, opened by
`Grampus.cmd` or `npm run ui`. It uses the existing journal and guided controller
for plan approval, file authorization, simplification, questions, retry, stop,
recovery, independent review, acceptance and verified local delivery. The server
is loopback-only, checks Host/Origin and a per-launch token, escapes supplied text,
and uses no hosted assets. Task workers have distinct controller identities.

Kickoff supplies a pinned complete small Git tree to a read-only subscription
conversation, asks consequential questions and creates reviewable proposals.
Conversion produces only an unapproved task. Repository/workspace/provider/time
limit selections remain authoritative. Proposal and question-round digests fence
stale browser actions; task decisions are rechecked within ownership transactions.
Failed initial turns resupply full context only on explicit continuation. Revision
intent invalidates an earlier proposal before provider claim. Batch blob reads
replace one subprocess per repository file.

The first live browser conversation used Codex to clarify the exact greeting.
Its approved plan contained a literal newline inside an inline JavaScript string.
Implementation completed, then regression execution correctly failed and stopped
before simplification/review/delivery. Files and failed output remain retained.
Generated CommonJS inline Node checks now receive syntax validation without
execution before a candidate can become a task; its regression test passes.

A corrected fresh standalone fixture draft completed through the browser:
Codex `gpt-6.1-sol` implemented one scoped file, the real syntax check passed,
the retained diff received an explicit simplification assessment, Claude
`claude-opus-5-5` independently reviewed with no findings, and separate acceptance
verified exact source bytes, process exit, stdout and stderr. Acceptance printed
exactly `accepted` plus LF. Supervised delivery verified local commit
`b8b2bf80364b36b83851b5c6dc9f75c23b22a215`. No push was performed. The original
failed task and its partial workspace are retained; no approved recipe was
silently rebound. This is live guided fixture evidence, not an ordinary-project
trial or evidence for both provider pairings/workspace modes.

Browser checks also confirmed selected-task persistence over reload, recovery from
a saved selection absent from the journal, the kickoff time-limit control and token
removal from the address bar. The trial used Orca's embedded Chromium browser.
Orca pointer/keyboard delivery became inconsistent after a tab reload; later
actions used the page's DOM buttons/forms through browser evaluation. Full native
input/accessibility and other-browser coverage remain release validation work.
Local reports, trial snapshots and screenshots are retained under ignored
`.grampus/dashboard-live/` and `.grampus/dashboard-final.png`.

Independent Claude source reviews identified and drove fixes to revision/proposal
freshness, first-turn failure context, user-selected time limits, approval
transaction binding and repeated question-round binding. Source review is distinct
from a release-wide independent review and does not itself establish test results.
Nine new focused offline tests passed, plus the extended independent-review
question regression. They include real worker/check processes and Git repositories;
provider replies in those automated tests are explicitly offline fixtures.
The new cases cover local access/origin checks, stale task/proposal rejection,
restart persistence, explicit failed assessment, unsupported content, invalid
generated JavaScript, pre-claim revision intent, failed connection continuation,
and reused question ids in planner/reviewer sessions. A reopened dashboard refused
takeover of its original live worker and successfully stopped that worker's actual
check without replay or delivery.

A final source review confirmed the server-side fixes and exposed preservation of
typed answers across polling-driven question changes. Browser controls now retain
the exact decision key/digest/version captured when rendered, and field values
are retained only within the same decision state. The offline browser regression
in `test/browser-binding.probe.js` passed all four assertions in the actual
dashboard: task/planner answers cleared on a new question round, and both forms
submitted their rendered key even when a newer global cache value existed. The
probe intercepts HTTP with fixture replies and starts no provider/Git work.

Final default-parallel complete suites passed **all 226 tests** on Windows with
Node 25.8.1 and Node 24.22.0, with no failures, cancellations or skips. Runtime
suites ran sequentially and took approximately 367 and 360 seconds respectively.
The final browser binding correction was also verified with the four assertions
above against the actual served page. Type checking, build, JavaScript syntax
checks and whitespace checks passed. Full-suite logs remain ignored under
`.grampus/dashboard-final-node25.log` and `.grampus/dashboard-final-node24.log`.

Ordinary-project trials remain blocked by the current 256 KiB full-repository
review limit for the locally inspected repositories. Context selection, remaining
release trials, clean distribution validation and cross-platform support remain
outstanding. No scheduler, automatic review repair, recipe rebinding, installer,
automatic push or PR delivery was added.

## Primary references consulted for earlier slices

The delivery slice also consulted Git's official [git-add](https://git-scm.com/docs/git-add)
and [git-commit](https://git-scm.com/docs/git-commit) documentation for index updates,
message files, hooks and empty-commit behavior.

- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude SDK streaming input and lifecycle](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude SDK user input interfaces](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Node.js SQLite binding and stability](https://nodejs.org/api/sqlite.html)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Atomic process/job assignment](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/)
- [Process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Durable .NET file flushing](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush)
- [libuv Windows process ownership](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)
- Local Orca guide: `orca skills get orca-cli --json`, resolved through
  `ORCA_CLI_COMMAND`; installed CLI help for agent launch and worktree discovery.

## Selected context and scale — 18 October 2026

New guided tasks select bounded pinned text rather than admitting only repositories
whose complete text fits 256 KiB. The approved context includes exact paths and a
pinned inventory digest. Mandatory changed-file/instruction context cannot be
silently dropped, and supporting text grants no editing permission. Planning context
changes invalidate proposals and require an explicit next turn. The UI searches
100 paths per page and displays omissions; directory summaries are bounded.

The implementation caches immutable Git metadata, batches selected blobs and
original changed-file blobs, batches raw commit/index verification by bytes, and
uses maps for edit-scope comparisons. Full snapshots retain raw content checks;
mutable file hashes are not reused from stat metadata. Repository byte count no
longer imposes the former 128 MiB snapshot bound. Individual input files, retained
changes and agent context still have separate limits, documented in
[REPOSITORY-CONTEXT.md](REPOSITORY-CONTEXT.md).

The Windows offline scale probe retained these synthetic local measurements:

| Measurement | 100,002 files / 1,600,038 bytes | 10,002 files / 163,856,406 bytes |
| --- | ---: | ---: |
| Cold pinned index | 202 ms | 596 ms |
| Selected blob context | 57 ms | 165 ms |
| Full raw worktree snapshot | 10.53 s | 2.31 s |
| Edit-scope verification | 165 ms | 22 ms |
| Raw commit-tree verification | 2.40 s | 3.66 s |
| Raw index verification | 2.45 s | 3.20 s |

The file-count probe returned 100 search results in 8.8 ms; 100 cached metadata
lookups took 0.16 ms. The byte-size probe ran alongside another worktree trial;
these figures are local observations, not portable performance guarantees. The
first checkout took 55.6 seconds. Each stability capture requires two matching
snapshots, and a complete task requires several captures. Fast UI/context lookup
does not eliminate full-repository disk costs.

A real guided task prepared a standalone 100,002-file worktree and reached the
explicit `awaiting_scope` checkpoint with just `AGENTS.md` and `target.js` supplied.
Preparation took 110.5 seconds. Its fixed no-change brief was fixture-authored;
no provider was called and no task completion or reviewed-delivery claim is made.
The initial trial exposed automatic CRLF conversion and one original-blob Git
process per changed file. That read-only capture was stopped and conservatively
reconciled without replay; the corrected trial used a fresh workspace. Standalone
checkout now disables automatic CRLF conversion for that single command, leaves
configuration unchanged, preserves explicit attributes/filters and allows five
minutes for creation. Original-blob reads are batched and evidence size is checked
during collection. Dedicated tests verify LF preservation and explicit CRLF attributes.

Read-only HTTP measurements against the real 100,002-file checkpoint returned an
8,866-byte task response in 316.6 ms cold and 1.75 ms cached. The state list was
398 bytes, taking 63.8 ms cold and 6.35 ms cached. No file inventory or report was
serialized into those polls. A regression fixture also verifies bounded responses
and invalidation after writes from another SQLite connection.

The actual embedded browser verified a 100k-file preview, 100-result search pages,
next-page navigation, adding a path, preserving input and selections across refresh,
context expansion with proposal invalidation and no provider job, and lazy report
loading that remains readable after refresh. The four offline question-round binding
assertions passed. The probe now freezes periodic refresh during fixture rendering,
removing a harness race with in-flight polling. These are DOM-driven Chromium
checks; native input/accessibility and broader browser coverage remain release work.

Complete offline suites passed all 235 tests on Node 25.8.1 (344.9 seconds) and
Node 24.22.0 (348.6 seconds), without failures, cancellations or skips. After final
hardening, all 15 focused context/dashboard tests passed again on both runtimes
(19.2 and 19.1 seconds). They include allowing later slices to edit earlier-created
files, refusing context changes racing with draft conversion, and refusing a settled
response's proposal after another controller changes context. Type/build, browser
JavaScript syntax and whitespace checks passed. Full suites ran sequentially.
Logs and JSON probe evidence remain ignored under `.grampus/`.

A larger-repository guided fixture also reached verified local delivery while
preserving an unchanged binary asset. Implementation/review replies in that test
are explicitly offline fixtures. No live model inference, ordinary-project trial,
release-wide independent review, installer validation or Orca-host scale trial was
performed for this change. Context suggestions are filename heuristics; autonomous
retrieval and approved-recipe/context revision remain outstanding.
