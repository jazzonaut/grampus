# Grampus ACP migration brief

## Objective and agreed direction

Evaluate and, if compatibility is demonstrated, adopt Agent Client Protocol (ACP) as Grampus's standard agent interface. The primary motivation is reducing maintenance as providers evolve, with easier support for additional agents. Prefer one ACP integration and a small capability policy over complete provider-specific implementations.

ACP means Agent Client Protocol: https://agentclientprotocol.com/protocol/v1/overview. It is unrelated to IBM's Agent Communication Protocol, which merged into A2A.

The user requested this brief for another agent. No migration has been implemented or approved in detail. Start by establishing compatibility and a concrete implementation plan. Do not treat the investigation as a decision to keep the current integrations indefinitely.

## Repository context

Workspace: C:/Stuff/Grampus. Read AGENTS.md and follow its rules. Consult the existing documents instead of recreating their contents:

- docs/ARCHITECTURE.md, especially Agent adapters and Repository access.
- docs/WORKFLOW.md and docs/PLAN.md.
- src/providers/types.ts: Connector, AgentSession and ConnectOptions.
- src/providers/codex.ts and src/providers/codex-protocol.ts.
- src/providers/claude.ts and src/providers/claude-protocol.ts.
- src/providers/reply-schema.ts, src/providers/integrations.ts.
- src/execution/edit-policy.ts, src/repository/repository-tools.ts and src/process/process.ts.

Both providers already implement a shared internal session contract. Grampus currently drives Codex App Server over stdio JSON-RPC and Claude through the pinned Claude Agent SDK.

The checkout contains substantial unrelated tracked and untracked work, including Orca integration, dashboard, configuration and desktop changes. Preserve it. Inspect git status before editing; do not reset, overwrite or include unrelated work in a commit. Do not touch the separately installed application or its journal.

## Verified upstream findings

Read-only source inspection confirmed that separate ACP adapters translate to the same underlying interfaces Grampus already uses:

- Codex: https://github.com/agentclientprotocol/codex-acp. Inspected commit a62b56847f473a2be6c67ea779c1ef9c7f227c38. src/CodexJsonRpcConnection.ts launches Codex App Server. src/AgentMode.ts defines approval/sandbox presets.
- Claude: https://github.com/agentclientprotocol/claude-agent-acp. Inspected commit bcf74c2fe8e32bd24714d45122529dcf2f99a279. src/acp-agent.ts imports the Claude Agent SDK, calls query(), handles canUseTool permissions and accepts provider-specific options through metadata.

These are adapter projects, not evidence that the underlying provider interfaces natively speak ACP. Older Zed repository/package names appear in search results; use the current repositories and verify released packages rather than assuming main is released.

A concrete concern: the inspected Codex adapter defaults to workspace-write with automatic approval review. Its read-only preset uses on-request approval. Grampus uses a read-only sandbox and untrusted approval. These are not equivalent; establish whether configuration or upstream changes can provide the required behaviour.

ACP provides sessions, prompts, updates, permissions, cancellation, optional client filesystem/terminal methods and MCP server configuration. Tool notifications alone do not establish that every operation is mediated. Verify each adapter's actual execution paths.

No live compatibility tests were run. Compatibility with Grampus's full requirements remains unproven. Recheck upstream versions and source before relying on these findings.

## Work to do

1. Build a requirements matrix from the current code, mapping each requirement to ACP core support, adapter configuration, an extension/upstream change, or an unresolved gap. Prioritise:
   - Controller-owned repository reads, including pinned planning/review snapshots and journalled tool results.
   - Exact approved edit scope, single-use decisions and journalling before authorisation.
   - Denial of agent commands and unwanted hooks/delegation or other execution paths.
   - Validated structured replies, including questions, reviews and quality lens assessments.
   - Subscription authentication enforcement and prevention of accidental API-key/backend switching.
   - Session resume, model selection, MCP integrations and usage reporting.
   - Cancellation, confirmed process exit, stale requests and recovery without replaying uncertain dispatches.
2. Inspect both adapters and their supported configuration surfaces. Distinguish portable ACP capabilities from provider-specific metadata. Check whether ACP v1 meets the requirements; v2 is a draft in the inspected documentation and should not be assumed necessary or stable.
3. Run a bounded compatibility experiment outside the installed application and production journal. Use temporary repositories and a test journal. Demonstrate allowed edits, denied out-of-scope edits/commands, snapshot-backed reads, structured replies, resume, cancellation and provider/adapter failure. Establish ownership and termination of the adapter, provider process and descendants.
4. Produce a recommendation and migration plan. Prefer fixing shared adapter gaps upstream where practical. Explain any unavoidable provider-specific configuration and maintenance that remains. An ACP label alone is not an acceptance criterion.
5. If implementation follows, place ACP behind the existing internal provider contract initially. Keep the controller and journal authoritative. Decide whether direct adapters can be removed after parity is proven; do not create indefinite dual implementations or legacy journal compatibility by default.

## Acceptance and validation

The target is demonstrably less provider-protocol code owned by Grampus, without weakening its authorisation, evidence or recovery guarantees. Define a capability contract so unsupported requirements fail explicitly and additional agents can be assessed consistently.

Use meaningful regression tests with real temporary Git repositories and SQLite files; fake providers belong in tests. Bug fixes begin with a failing test. Rebuild the server before running compiled tests. Run npm run check before declaring implementation complete, plus appropriate targeted and full checks for the affected scope. Update current-state documentation with code and mark unbuilt behaviour as Planned. Follow AGENTS.md for settings, limits, stop reasons, UK English and commits.

This handoff itself changes no repository files and requires no code checks.

## Suggested skills

- Use prototype if a disposable compatibility experiment is useful; inspect its SKILL.md first.
- Use tdd if proceeding with test-first implementation, and run setup-matt-pocock-skills beforehand as required by those skills.
- Use diagnose for a concrete adapter failure, following its setup requirements.
- Use openai-docs for questions about official Codex behaviour; inspect ACP adapter source separately as a third-party integration.
- Use orca-cli only if creating an Orca-managed worktree or handing execution to another Orca agent. The user is handling this handoff; do not dispatch agents automatically.
