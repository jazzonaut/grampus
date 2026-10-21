# Windows alpha release

The first release target is a small Windows alpha, ahead of the broader
three-platform product described in [DESIGN.md](../DESIGN.md). It should let one
person finish a small real coding task without coordinating each provider call, check
and delivery by hand. This is the target, not a claim that the alpha is ready.

## Scope

- Windows 10 or later, local execution, Node.js 24 or later and Git.
- Existing Codex and Claude subscription logins, with independent other-provider
  review. No separately billed API access.
- Standalone Git worktrees and optional local Orca workspaces.
- Regular-file repositories with native implementation, bounded read-only exploration for planning
  and review, and hashed binary assets. Changed files and instructions are never silently
  excluded from review. See [repository context](REPOSITORY-CONTEXT.md).
- Configured MCP connections (including Linear ticket reads) and read-only reference
  folders.
- Up to `maxConcurrentTasks` guided tasks (2 by default, at most 4) executing at once per
  journal, each in its own worktree.
- Local verified commits and a journal-derived report. The user pushes.

After the alpha: macOS and Linux, published installers, dedicated Linear workflow
automation, pull request delivery and broader unattended operation.

## Release gates

| Gate | Requirement | State |
| --- | --- | --- |
| 1. Dependable recovery | Interrupted work resumes through a fresh attempt to verified delivery, keeping partial edits and approval. Missing settlement proof stays blocked | Built, with offline tests |
| 2. One guided workflow | Kickoff, versioned approval, workspace, native candidate implementation, readiness, validation, acceptance, independent review with simplification, delivery and report, stopping with a clear reason when needed. No inferred passes or replay after restart | Built; automatic by default ([WORKFLOW.md](WORKFLOW.md)) |
| 3. Basic interface | Kickoff, approval, progress, questions, findings, stop and recovery controls and final evidence over the same controller state as the CLI | Built ([DASHBOARD.md](DASHBOARD.md)) |
| 4. Real-project trials | Small changes in existing repositories, including a review finding that needs repair and an interrupted implementation finished through a fresh attempt, across both provider pairings and both workspace modes | Outstanding. Fixture pilots and probes do not count |
| 5. Review and distribution | Independent review of Grampus itself; clean installation, subscription discovery, state after restart and readable reports verified; full offline suite on supported Node versions; limitations recorded | Outstanding |

Gate 4 is the next priority. [PLAN.md](PLAN.md) step 7 sets out how those trials are
recorded.

## Current verification limits

Native implementation has no filesystem or command sandbox. Git and repository instruction
changes are detected at settlement; this is not isolation from arbitrary native commands.
Artifact digests exclude ignored dependencies, caches and external services. Passing checks and
independent review do not establish correctness beyond their observed coverage.

Read-only Grampus repository tools return text and encoded changes. They do not currently deliver
rendered images to the reviewer. A plan requiring visual inspection needs an available image-capable
integration or a consequential evidence decision; screenshot names and hashes alone do not prove
appearance. A provider's own image-capable read tool can also supply the observation when available.
Review instructions require a question when required visual evidence cannot be inspected.
**Planned:** a shared, artifact-bound image inspection capability for both review providers.
Real-project trials and independent review of Grampus remain outstanding release gates.
