# Initial integration evidence

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

The live provider run itself was not interrupted. This mode is limited to Claude,
standalone Windows workspaces and existing UTF-8 files. It is an application tool
policy, not an OS filesystem sandbox; external edits can race path checks. Native
Codex editing, Orca editing, shell tools and wider file operations remain disabled.
Grampus itself has not had independent review. Operational paths, journals, provider
transcripts and fixture repositories remain local and ignored.

Implementation references: Claude [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
and [permissions](https://code.claude.com/docs/en/agent-sdk/permissions). OpenAI Docs
skill guidance was used to inspect [Codex app-server approvals](https://learn.chatgpt.com/docs/app-server)
for the future adapter; no Codex editing permissions were enabled in this slice.

## Primary references consulted

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
