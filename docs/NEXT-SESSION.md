# Resume Grampus implementation

Checkpoint: 17 October 2026, after durable state, conversations, Git/Orca workspaces,
task-linked session ownership, recoverable Windows checks, artifact review,
exact-output acceptance verification, explicit simplification and a live standalone
task pilot. The user continued implementation in the
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

- TypeScript/Node controller, SQLite schema 7, journal-derived Markdown task report.
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
- 114 offline tests passed on Windows with Node 24.22.0 and 25.8.1, covering real Git,
  controller crashes, Orca protocol fixtures, lease races, rollback, uncertain startup,
  stale bindings, real command results, timeouts, detached descendants, controller/
  supervisor crashes, receipt recovery, stale artifacts, review context, output
  assertions, final gates and CLI submission/verification. Earlier live Orca 1.4.229 creation and
  recovery passed; temporary probe worktrees were removed through Orca.
- Both live probes passed question/answer, context across controller restarts,
  supplied-code review findings, interruption and resumption with earlier context.

The demo is synthetic and offline reviewers are fixtures. The opt-in standalone
`npm run probe:task -- --live` now reaches completion with both live providers and
all gates. Its controller applies only a single allowlisted output statement; it
does not enable native provider editing or general recoverable delivery. Local probe
evidence remains under ignored `.grampus/task-probes/`. Do not commit those journals,
reports or fixture repositories. The full task has not been repeated through Orca
or with a mid-task controller crash; narrower recovery tests/probes already exist.
The implementation itself has not had independent review. macOS and Linux remain
unverified. Temporary journals, generated schemas, local probe transcripts and
dependency/build directories are intentionally not committed. The evidence document
contains the durable summary, and the probe script can reproduce the checks.

## Next implementation slice: provider tools and delivery

Start with the existing source and a small concrete plan. Do not rebuild the
controller or broaden into the dashboard first.

1. Define native provider tool authorization and repository-rule application before
   enabling agent edits. The check interface takes explicit trusted command JSON and
   acknowledges discovered `AGENTS.md`/`CLAUDE.md`; it is not an agent tool policy.
   Continue to keep successful conversational replies separate from task evidence.
2. Define delivery binding and recovery before automating slice commits. The live
   pilot commits explicitly after completion and journals that fact; staging and HEAD
   change the digest. General delivery needs to prove the committed tree matches
   checked content and reconcile interrupted staging/commit without blind replay.
3. Extend the live pilot to native provider edits once their policy is defined,
   demonstrate mid-task interruption/recovery, and repeat through Orca. Keep semantic
   simplification assessment explicit and choose checks that demonstrate the outcome.
4. Define safe workspace release/rebinding for changed briefs and a recovery path for
   unknown provider PIDs. Failed reservations currently stay blocked for investigation.
   Keep using Orca's supported interfaces for Orca-owned state; its CLI exiting does
   not prove all background activities stopped. A Grampus lease does not control agents
   launched separately through Orca.
5. Add macOS/Linux tool supervision and bounded worker concurrency before unattended
   scheduling. The current Windows helper supervises ordinary descendants, not work
   delegated to WMI, existing services or external agents. A provider process exiting
   still does not prove that all provider tools stopped.
6. Broaden review context beyond small UTF-8 repositories and acceptance observations
   beyond exact decoded stdout. Keep context/evidence scope explicit and preserve
   failed/skipped results rather than claiming coverage from a model reply.

Prefer a fixture repository with a clear before/after example, such as a greeting
command with exact output. Preserve the user's working changes. Record failures,
skipped checks, uncertain liveness and provisional decisions explicitly.

## Open decisions and limitations to carry forward

- Execution records now link tasks, versions, attempts and sessions. There is no
  automatic scheduler or end-to-end repository task runner yet. Successful conversations
  leave implementation open; they cannot create a successful artifact or pass a gate.
- Native provider tool approvals and repository-rule application need design and
  validation before enabling writes. Current conversation restrictions are deliberate.
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
  is implemented. Remote hosts are rejected, and the adapter never changes Orca-owned
  worktrees through raw Git writes.
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

If working through Orca, also run `npm run doctor -- --orca`. Read its installed,
version-matched CLI guide before manipulating Orca-owned state. Live probes are
optional after unrelated changes and consume subscription usage; repeat them when
changing the corresponding adapter or when current compatibility is uncertain.
