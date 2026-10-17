# Resume Grampus implementation

Checkpoint: 17 October 2026, after durable state, conversations, Git/Orca workspaces
and task-linked session ownership. The user continued implementation in the
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

- TypeScript/Node controller, SQLite schema 5, journal-derived Markdown task report.
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
- 85 offline tests passed on Windows with Node 24.22.0 and 25.8.1, covering real Git,
  controller crashes, Orca protocol fixtures, lease races, rollback, uncertain startup
  and stale bindings. Earlier live Orca 1.4.229 creation and
  recovery passed; temporary probe worktrees were removed through Orca.
- Both live probes passed question/answer, context across controller restarts,
  supplied-code review findings, interruption and resumption with earlier context.

The demo is synthetic. Live probes use a supplied snippet and conversations; they
do not prove repository execution, full independent review or task completion.
The implementation itself has not had independent review. macOS and Linux remain
unverified. Temporary journals, generated schemas, local probe transcripts and
dependency/build directories are intentionally not committed. The evidence document
contains the durable summary, and the probe script can reproduce the checks.

## Next implementation slice: workspaces and execution

Start with the existing source and a small concrete plan. Do not rebuild the
controller or broaden into the dashboard first.

1. Build a narrowly scoped repository command/check runner on the existing bindings
   and workspace leases. It must preserve repository instructions, supervise owned
   tool processes and record intent before dispatch. Do not turn conversational replies
   into implementation success. Artifact references remain trusted caller inputs.
2. Define safe workspace release/rebinding for changed briefs and a recovery path for
   unknown provider PIDs. Failed reservations currently stay blocked for investigation.
   Keep using Orca's supported interfaces for Orca-owned state; its CLI exiting does
   not prove all background activities stopped. A Grampus lease does not control agents
   launched separately through Orca.
3. Connect real repository results to task evidence. Preserve repository
   instructions, inspect the actual diff and bind evidence to a verified commit or
   content digest. Current artifact references and task evidence are trusted caller
   inputs, not verified repository state.
4. Establish worker ownership and bounded concurrency before unattended scheduling.
   Extend interruption tests to tool subprocesses; a stopped agent process alone
   does not prove that all tools stopped.
5. Run one tiny approved task through implementation, simplification, real checks,
   an independent review, acceptance verification, a local slice commit and report.
   Demonstrate recovery and then repeat with and without Orca.

Prefer a fixture repository with a clear before/after example, such as a greeting
command with exact output. Preserve the user's working changes. Record failures,
skipped checks, uncertain liveness and provisional decisions explicitly.

## Open decisions and limitations to carry forward

- Execution records now link tasks, versions, attempts and sessions. There is no
  automatic scheduler or end-to-end repository task runner yet. Successful conversations
  leave implementation open; they cannot create a successful artifact or pass a gate.
- Native provider tool approvals and repository-rule application need design and
  validation before enabling writes. Current conversation restrictions are deliberate.
- Same-provider independent-review fallback is recorded, but there is no review
  orchestration, two-round arbitration loop or evidence collection from real checks.
- Effort/model presets, retry/escalation allowances and global concurrency values
  are not chosen. Probe models are observed defaults, not product presets.
- Unknown provider PIDs and reused/live PIDs block recovery. There is no automatic
  process adoption, force-stop command or heartbeat mechanism.
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
