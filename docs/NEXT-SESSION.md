# Resume Grampus implementation

Checkpoint: 18 October 2026, after durable state, conversations, Git/Orca workspaces,
task-linked session ownership, recoverable Windows checks, artifact review,
exact-output acceptance verification, explicit simplification and supervised local
delivery and supervised Claude/Codex native file editing with live standalone and
local Orca task pilots.
The next slice added a standalone two-file library/CLI pilot with a durable
simplification checkpoint; its live Codex implementation and Claude review reached
verified local delivery on 18 October 2026.
The follow-up also passed the reverse provider pairing, Orca multi-file delivery,
and live Claude mid-edit controller-loss recovery in both workspace modes.
The latest slices add exact native file creation/deletion policies for both providers
and the multi-file pilot's `--create-library` / `--delete-obsolete` modes. Directory
creation/removal remains disabled.
Explicit no-change delivery now verifies unchanged HEAD/index/files under supervision,
records its outcome and completes without a commit; receipt recovery is read-only.
Sequential slice plans now use the same gates and supervised delivery. Intermediate
delivery readies a fresh slice attempt in the same workspace; final verification
covers all task criteria. Schema 10 prevents older controllers from completing a
multi-slice task after its first delivery.
The user continued implementation in the
same session and authorized pushing the repository.

## Read first

1. [DESIGN.md](../DESIGN.md): agreed product behavior, autonomy, reviews and delivery.
2. [README.md](../README.md): commands and current limitations.
3. [ARCHITECTURE.md](ARCHITECTURE.md): implemented state and process contracts.
4. [IMPLEMENTATION.md](IMPLEMENTATION.md) and
   [INTEGRATION-EVIDENCE.md](INTEGRATION-EVIDENCE.md): sequence and verification.

The repository remote is configured. Preserve the user's existing personal Git
author and committer identity; check `git var GIT_AUTHOR_IDENT` and
`git var GIT_COMMITTER_IDENT` before future commits rather than replacing Git config.
Default delivery remains local unless the user authorizes an external action.

## Completed

- TypeScript/Node controller, SQLite schema 10, journal-derived Markdown task report.
- Task briefs, exact-version approval, attempts, provisional decisions, four
  completion gates, stale-result rejection and explicit recovery states.
- Live Codex app-server and Claude Agent SDK conversations with subscription
  preflight, validated questions/review findings and persisted provider identity.
- One active controller per conversation, deadlines, stop requests, confirmed owned
  process exit, conservative recovery and zero automatic inference retries.
- CLI demonstration, discovery commands and repeatable opt-in live probes.
- Standalone worktree creation with exact-version approval, durable task/path
  reservations, canonical paths, pinned base, ownership lock, inspection and recovery.
- Local Orca worktree creation through its CLI, stable instance verification and
  recovery of a lost reply through request-marker discovery without creation replay.
- Atomic task/version/attempt/session bindings with implementation/review roles,
  approved context, per-workspace leases, fenced settlement and process-based recovery.
- Snapshot-bound command checks, Windows Job Object supervision, retained diffs and
  bounded output, and atomic implementation submission with controller validation.
- Durable supervisor receipts, explicit check/read-only recovery without replay,
  bounded text artifact reviews, criterion-mapped output assertions and completion
  revalidation. New review/verification requests invalidate an older gate pass.
- Explicit `execution-simplify` assessment with verified artifact/instruction digests,
  all three outcomes, newer-request invalidation and read-only crash recovery.
- Live standalone pilot: Codex supplied an allowlisted greeting response, controller
  applied it, Claude independently reviewed it, real regression and exact-output
  verification passed, all gates completed, and a local fixture commit/report was made.
- Supervised standalone Windows delivery verifies staged bytes and final commit,
  index, working files and instructions; durable receipt recovery adopts only an
  exact successful commit without replay. The live pilot now uses this path.
- Native Claude implementation with explicit snapshot-bound file policies, per-tool
  journaling, whole-process-tree supervision, post-turn scope checks and receipt-only
  recovery. The native live pilot used Claude edits and independent Codex review,
  then real validation, acceptance and verified local delivery.
- Native Codex implementation uses the same supervised lifecycle. Per-item patch
  approvals verify thread/turn/item identity, the complete update-only file set and
  durable authorization. Read-only mode and client approval routing are confirmed;
  root/session grants, commands and other permission requests are refused. The live
  Codex edit → Claude review → checks → verified local delivery pilot passed.
- Native editing and supervised local delivery now support local Orca workspaces.
  Orca owns lifecycle/identity; Grampus owns provider processes and ordinary Git
  staging/commits. Worker-side delivery fences and repeated Orca identity checks
  reject replaced/archived instances before staging, before commit and at acceptance.
  A live Codex edit → Claude review → checks → verified local commit pilot passed
  in an Orca-created worktree. Its temporary worktree was removed through Orca.
- `probe:multifile` implements a summary library and JSON CLI through two explicitly
  writable existing files. A separate oracle covers successful and invalid input,
  input preservation, exit codes and exact streams. It pauses after validation for
  inspection and an explicit simplification assessment, then uses independent review,
  saved-oracle acceptance and verified delivery. A live Codex → Claude standalone run
  completed; the reviewer retained two nonblocking suggestions about numeric overflow
  and broad exception handling. The scope does not define aggregate overflow behavior.
- Reverse Claude → Codex standalone delivery and Codex → Claude Orca multi-file
  delivery also passed. `--interrupt-after-edit` passed with live Claude in both
  workspace modes: controller loss during a partial edit, supervisor receipt, a new
  recovery CLI process, preserved contents and a stopped task without inference replay.
  The Orca fixture workspaces and partial edits are retained for inspection.
- Exact native file creation via optional `create` policy paths supports both
  providers, with absent/non-ignored targets, existing parents, bounded text and
  final snapshot membership checks. `probe:multifile -- --live --create-library`
  passed standalone delivery in both provider pairings after explicit simplification,
  independent review and saved-oracle acceptance. Codex output retained one
  nonblocking aggregate-overflow suggestion; Claude output had no review findings.
  Real offline controller-loss fixtures preserved a partial new file through receipt
  recovery without replay. Live creation in Orca and live mid-creation recovery
  have not been exercised separately.
- Exact deletion policies now support both providers, with immutable snapshot bytes
  and no overlap with other writable paths. Claude's single in-process deletion tool
  checks active-turn ownership and the journal at the actual unlink; Codex uses its
  ordinary one-item patch approval. Both standalone live provider pairings passed a
  combined edit/create/delete pilot through explicit simplification, independent
  review, saved-oracle acceptance and verified local delivery. Claude review retained
  two nonblocking suggestions on the Codex fixture; reverse review had no findings.
  Live Claude and Codex controller loss just after deletion also recovered through a new CLI,
  preserving the absence without inference replay or completion evidence.
- Explicit `mode: no_change` delivery verifies raw HEAD/index/files and unchanged
  instructions without staging, hooks or an empty commit. All gates still apply.
  Receipt recovery is read-only and rejects changed state or Orca identity. Real
  controller exits, CLI recovery, journal rollback, index locks and dirty/staged
  mismatches are covered. The preceding complete offline suite passed 184 tests
  without failures or skips on Windows, Node 25.8.1; focused delivery and Orca
  suites each passed 18. No new live provider/Orca pilot or other-platform run was made.
- The preceding scoped-file offline suite passed 178 tests without skips on Windows,
  Node 25.8.1. Focused provider/implementation checks passed 39 tests, pilot checks
  passed 7, and doctor confirmed both subscription logins. The creation/deletion
  suites have not run on Node 24. The preceding creation checkpoint passed 165 tests.
- 155 offline tests passed on Windows with Node 25.8.1 after the recovery pilots;
  the preceding 151-test suite also passed on Node 24.22.0. Coverage includes real Git,
  controller crashes, Orca protocol fixtures, lease races, rollback, uncertain startup,
  stale bindings, real command results, timeouts, detached descendants, controller/
  supervisor crashes, receipt recovery, stale artifacts, review context, output
  assertions, final gates and CLI submission/verification. Earlier live Orca 1.4.229 creation and
  recovery passed; temporary probe worktrees were removed through Orca.
- Both live probes passed question/answer, context across controller restarts,
  supplied-code review findings, interruption and resumption with earlier context.
- Sequential approved slice continuation now records verified deliveries, clears
  old evidence and requires fresh attempt/session bindings. The focused slice/Orca
  suite passed 25 tests with no failures or skips on Windows, Node 25.8.1. It covers
  actual two-slice regression and acceptance commands, fixture independent review,
  supervised commits, CLI restarts, controller exits, receipt recovery, no-change,
  rollback, stale sessions/evidence, raw continuation checks and schema 9 migration.
  No live provider/Orca-host pilot or other-platform run was made for this slice.
  The first default parallel full runs passed 190/191 and 189/191; existing recovery
  fixtures intermittently refused live/unverifiable supervisor or controller PIDs.
  The failed deletion case passed alone. Full verification was also run with two
  workers and passed all 191 tests without failures or skips. Type checking and
  whitespace checks also passed. The cause of the parallel failures remains
  unconfirmed, and no PID/receipt guard was changed. Investigate process identity
  and test-process concurrency before treating default parallel runs as reliable.

The demo is synthetic and offline reviewers are fixtures. The opt-in
`npm run probe:task -- --live` now reaches completion with both live providers and
all gates. Its default mode applies a single allowlisted Codex response; `--native`
uses actual Claude Read/Edit/Write tools and Codex review; `--native-codex` uses Codex
patches and Claude review. Add `--orca` to create a local Orca fixture workspace.
Standalone and local Orca delivery and
its explicit recovery path are implemented; local probe
evidence remains under ignored `.grampus/task-probes/`. Do not commit those journals,
reports or fixture repositories. The live greeting task passed through Orca; the
multi-file pilot also demonstrates live Claude controller-loss recovery in both
workspace modes. Offline delivery fixtures exercise
actual controller exits before dispatch and after commit, followed by recovery.
Native editing fixtures also kill a controller during a running file-writing tool,
confirm the supervisor receipt and preserve partial edits without replay.
The implementation itself has not had independent review. macOS and Linux remain
unverified. Temporary journals, generated schemas, local probe transcripts and
dependency/build directories are intentionally not committed. The evidence document
contains the durable summary, and the probe script can reproduce the checks.

## Next implementation slice: broader tasks and recovery pilots

Start with the existing source and a small concrete plan. Do not rebuild the
controller or broaden into the dashboard first.

1. Multi-slice continuation is implemented through optional approved `slices` and
   per-task progress. Each slice requires fresh gates and delivery; the final slice
   verifies every task criterion. A live multi-slice provider pilot remains useful.
   The ordinary CLI explicitly starts the next slice; no scheduler or arbitration
   is implemented. Local delivery binds the checked digest to the exact commit.
   Recovery needs a terminal receipt after dispatch; failed/uncertain operations
   never trigger commit replay or Git resets.
2. Live Claude mid-edit recovery now passes in standalone and Orca workspaces.
   Live Claude/Codex standalone recovery just after scoped deletion also passes.
   Codex live recovery in Orca and completing a task through a fresh attempt after
   recovery remain useful follow-ups. Keep simplification explicit and use
   checks that demonstrate the outcome; do not automatically replay interrupted work.
3. Define safe workspace release/rebinding for changed briefs and a recovery path for
   unknown provider PIDs. Failed reservations currently stay blocked for investigation.
   Keep using Orca's supported interfaces for Orca-owned state; its CLI exiting does
   not prove all background activities stopped. A Grampus lease does not control agents
   launched separately through Orca.
4. Add macOS/Linux tool supervision and bounded worker concurrency before unattended
   scheduling. The current Windows helper supervises ordinary descendants, not work
   delegated to WMI, existing services or external agents. A provider process exiting
   still does not prove that all provider tools stopped.
5. Broaden review context beyond small UTF-8 repositories and acceptance observations
   beyond exact decoded stdout. Keep context/evidence scope explicit and preserve
   failed/skipped results rather than claiming coverage from a model reply.

Prefer a fixture repository with a clear before/after example, such as a greeting
command with exact output. Preserve the user's working changes. Record failures,
skipped checks, uncertain liveness and provisional decisions explicitly.

## Open decisions and limitations to carry forward

- Execution records now link tasks, versions, attempts and sessions. There is no
  automatic scheduler or end-to-end repository task runner yet. Successful conversations
  leave implementation open; they cannot create a successful artifact or pass a gate.
- Briefs may contain 1–64 ordered slices with exact task-criterion references. All
  criteria must be covered by the plan. Intermediate verification uses current-slice
  criteria; the final slice uses all task criteria and its review covers integration.
  Delivery atomically records progress and readies the next slice with cleared
  attempt/evidence. Direct completion cannot skip planned deliveries. Continuation
  requires the prior delivered HEAD, raw clean index/files and unchanged instructions;
  retries preserve partial edits on the current slice. Workspace/base/version/Orca
  identity remain unchanged. Receipt recovery advances once without replay.
- `execution-implement` supports Claude and Codex on standalone/local Orca Windows workspaces, with
  explicit existing-file and exact creation/deletion policies (1–64 combined paths, UTF-8
  files at most 256 KiB each). Optional `create` targets must be absent and
  non-ignored, with existing directories; `files` may be empty for creation-only work.
  Optional `delete` targets must be existing snapshot files with unchanged bytes,
  cannot overlap other lists and may only be removed. Claude exposes the controller's
  single in-process deletion tool only when this list is nonempty; its handler checks
  active-turn ownership, scope and the journal again before unlinking.
  Claude SDK hooks check/journal file decisions; StructuredOutput only validates the
  final reply. Codex uses one-item patch approvals and a bounded supplied text context
  (768 KiB encoded), with at most 64 patch items per turn. No shell, external tools,
  delegation, directory creation/removal, moves or control-file edits. Instructions are supplied and
  hashed; scope is checked after exit. Ordinary provider conversations cannot be reused
  for editing; create a fresh implementation session.
  A provider tool policy is not an OS filesystem sandbox. Editing sessions require
  implementation commands and cannot resume via ordinary session-send.
- Native implementation uses a supervised worker and receipt recovery, never
  conversation PID-only recovery. Unknown shutdown keeps the lease; explicit recovery
  records interruption and preserves edits, requiring a fresh execution attempt.
  Successful native replies leave implementation running with all gates outstanding.
- Explicit independent artifact review and real acceptance checks are implemented;
  same-provider fallback is recorded. There is no automatic two-round arbitration or
  review/implementation scheduling. Review supports at most 256 KiB of snapshot-visible
  UTF-8 text and a bounded prompt; provider tools remain disabled.
- Effort/model presets, retry/escalation allowances and global concurrency values
  are not chosen. Probe models are observed defaults, not product presets.
- Unknown provider PIDs and reused/live PIDs block recovery. There is no automatic
  process adoption, force-stop command or heartbeat mechanism.
- `check-recover` requires a persisted pre-dispatch boundary or matching completion
  receipt plus absent controller/supervisor on the same host. It never accepts a lost
  success. `execution-recover` handles new read-only snapshot/submission/simplification/completion
  leases. Legacy missing proofs, a killed supervisor without a receipt and unknown
  provider identity remain blocked. Do not add PID-only force-unlock or replay.
- The check helper requires Windows 10+, a hidden detached Node host and Windows
  PowerShell `Add-Type`; `src/native` accompanies the compiled JS checkout. Preserve
  `<database>.checks/` with the journal. Receipts/output remain local and ignored by Git;
  they trust the local account, and there is no retention cleanup yet.
- `execution-deliver` runs before task completion, requires all gates and supports
  standalone and local Orca Windows workspaces. It stages checked content and preserves
  configured identity/hooks/signing. Filters or line-ending normalization that alter
  checked raw bytes are rejected; hook effects may leave an unaccepted commit. Failed
  deliveries preserve files/index/locks for investigation rather than resetting them.
  A successful receipt plus exact commit/content proof permits explicit recovery;
  missing receipts retain ownership. Native shell execution remains disabled.
  Orca delivery adds a journal/execution/workspace/instance binding and checks it in
  the worker before Git writes. Identity failure after a commit leaves an unaccepted
  commit and no task completion. Existing schema 9 standalone receipts still work.
- Content digests omit ignored dependencies/build outputs and external environment/
  services. Snapshots use two matching reads, not an atomic filesystem snapshot.
  Symlinks, submodules and unresolved indexes are unsupported. Keep command specs
  outside the workspace to avoid invalidating their own digest. The direct Workflow
  API still trusts callers; the explicit review/verification/completion commands
  revalidate content, but there is no continuous watcher after completion. Acceptance
  expectations and criterion mapping require a meaningful caller-selected check.
- Workspace leases have no expiry and cover participating sessions in one journal.
  Uncertain startup retains a lease even before a PID appears. A late connection is
  closed without a prompt, but missing identity still needs investigation. Failed or
  interrupted implementation attempts require a fresh execution/session; closed or
  superseded linked sessions cannot resume. Ordinary unlinked sessions still can.
- Workspace creation recovery can adopt a verified clean worktree after a lost
  response. Missing or mismatched results remain reserved; no creation replay,
  workspace removal or task-version rebinding is available yet. Git hooks/filters
  use normal repository configuration and their process trees are not supervised.
- Orca creation requires an explicit base ref and chooses its own path/branch. Its
  default terminal settings still apply with setup skipped. Unknown create outcomes
  stay reserved until exact discovery succeeds; no create retry or host cancellation
  is implemented. Remote hosts are rejected. Orca-owned lifecycle and metadata are
  never changed through raw Git; ordinary staging/commits use Grampus's supervised
  writer because the installed CLI exposes no commit API. Editing and delivery do
  not launch agents through Orca or send terminal input. Orca session coordination
  remains unimplemented; other Orca agents can still race Grampus operations.
- `probe:task -- --live --native-codex --orca` registers an isolated fixture repository
  and creates its worktree through Orca. It retains evidence and reports the instance
  key. Remove only verified finished fixture worktrees through Orca; the registration,
  fixture repository and journal remain local. No automatic fixture cleanup exists.
- `probe:multifile -- --live [--provider claude] [--orca]` stops at a submitted-artifact
  checkpoint. Inspect the code and edit its skipped assessment template, then use
  `--live --finish <execution-id> --db <journal> --assessment <file>`. Continuation
  is journaled before review and cannot be replayed; use ordinary operation recovery
  after interruption. The saved validation command and expected stdout are reused
  for acceptance. Reverse pairing and Orca delivery now pass. Add
  `--interrupt-after-edit` to crash the owned controller after a real library edit
  and recover through a new CLI process; this mode intentionally leaves the task
  stopped and saves `recovery.json`. Live Claude passed both workspace modes.
  The partial files and Orca workspaces are retained; local probe evidence stays ignored.
  Add `--create-library` at startup to omit summary.cjs from the baseline and authorize
  its exact creation path. This combines with either provider, workspace mode and
  interruption mode. Continuation reads the saved creation metadata without a new flag.
  Add `--delete-obsolete` to approve removal of an obsolete tracked file; the saved
  oracle checks absence and the checkpoint retains deletion metadata. With
  interruption mode, deletion happens first and recovery preserves that absence.
- Retention, safe-checkpoint transfer, installer packaging, platform CI, browser
  dashboard, notifications, Linear and opt-in PR delivery are still outstanding.
- Keep subscription authentication as the default. Do not silently enable API
  billing, infer actual billed cost from estimates, or sum cumulative usage events.
- Documentation and fixtures should use portable paths and omit personal account
  identifiers, machine-specific checkout paths and local session transcripts.

## Re-establish the baseline

```sh
git status --short
npm ci
npm test
npm run doctor
```

Run complete Node-version suites sequentially on Windows. Overlapping Node 24/25
suites produced two recovery-fixture failures at this checkpoint; isolated checks
and a separate Node 24 full run passed. The exact cause was not established, and
PID/receipt recovery guards were not weakened. See the integration evidence.
The latest default parallel runs also intermittently refused liveness in existing
recovery fixtures. Preserve their logs; a full two-worker run passed all 191 tests:

```sh
npm run build
node --test --test-concurrency=2 dist/test/*.test.js
```

If working through Orca, also run `npm run doctor -- --orca`. Read its installed,
version-matched CLI guide before manipulating Orca-owned state. Live probes are
optional after unrelated changes and consume subscription usage; repeat them when
changing the corresponding adapter or when current compatibility is uncertain.
