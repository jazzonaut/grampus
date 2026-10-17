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

## Primary references consulted

- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude SDK streaming input and lifecycle](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude SDK user input interfaces](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Node.js SQLite binding and stability](https://nodejs.org/api/sqlite.html)
- Local Orca guide: `orca skills get orca-cli --json`, resolved through
  `ORCA_CLI_COMMAND`; installed CLI help for agent launch and worktree discovery.
