# Grampus design and decision record

> This is the product intent record, not a description of what is built.
> Current behaviour is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/WORKFLOW.md](docs/WORKFLOW.md).

Grampus coordinates coding tasks with a clear approved outcome, sequential implementation slices, independent reviews, configurable quality checks, and a durable evidence trail. It should save human attention without becoming a source of unnecessary model usage or maintenance work.

This record captures discovery decisions as of 17 October 2026. Agreed product behavior is distinguished from proposed technical choices. Recording these requirements does not constitute approval of an implementation plan.

## Product scope

- Installable local application designed for Windows, macOS, and Linux. Platform support must be validated separately; design portability is not proof of tested compatibility.
- Fully usable with or without Orca from the first version. Orca is an optional integration, not the owner of Grampus workflow state.
- Codex and Claude Code are the initial agents. Both can serve as planner, implementer, reviewer, or arbitrator. Additional agents can be integrated later.
- Multiple independent tasks may run concurrently. Each task has its own Git worktree, while implementation slices within a task run sequentially.
- A shared concurrency limit controls active agents across tasks.
- Execution is local initially. The machine must remain available for work to continue. Remote execution and automatic synchronization between machines are outside the initial scope.
- Existing agent subscriptions are preferred. Separately billed API access is optional and must be explicitly enabled.

## Kickoff and approval

A task can begin with a plain-language brief, an optional Linear issue, or both. Linear must not be required to use Grampus.

Before proposing implementation, the agent investigates the relevant code, current behavior, repository conventions, and supplied requirements. It identifies ambiguities that could materially change the result and proposes answers for the user. These ambiguities require resolution in both autonomy modes before implementation is approved. Minor details may use explicit defaults.

The initial acceptance brief captures intended behavior, exclusions, concrete examples, relevant edge cases, and remaining assumptions. Where small output details matter, it includes a representative input and expected output, mockup, or sample artifact. For example, an export task should establish which metadata appears, where it appears, and what happens when values are missing.

The implementation plan is concise and proportional to task complexity. It shows slices, acceptance criteria, validation, review depth, selected agents and models, effort, and retry/escalation allowances. Larger or riskier plans receive independent agent review before presentation to the user.

Discussion happens in agent chat. Grampus presents the authoritative current criteria, examples, plan, questions, and approval state. Approval applies to a specific version. Later changes remain visible, and relevant examples and criteria carry through to implementation and final verification.

## Autonomy and steering

| Mode | Behavior |
| --- | --- |
| Unattended, default | After initial approval, agents may make reversible local provisional decisions, including changes beyond the approved approach, behavior, scope, public interfaces, or significant architecture. Record the decision, rationale, affected work, and how it can be undone. Decisions crossing approval boundaries require user acceptance before the task is marked complete. |
| Supervised, opt-in | Agents resolve implementation details independently but pause before changing agreed behavior, scope, public interfaces, or significant architecture. They may continue independent checks or investigation while waiting, without beginning dependent implementation slices. |

Neither mode relaxes the requirement to resolve consequential ambiguities at kickoff. Unattended operation does not independently authorize pushing, publishing, merging, deploying, or other external actions beyond the enabled delivery mode and explicit task authorization.

Normal steering is recorded immediately and applied at the next safe checkpoint. The active operation is allowed to settle before affected criteria and remaining work are updated. Checks and reviews invalidated by the change must be repeated. Material user-requested changes to the intended outcome return for approval. A separate Stop now control requests immediate interruption; its implementation must distinguish a requested stop from a confirmed stopped process.

## Slices and reviews

Each slice follows implementation, simplification, relevant validation, independent review, resolution of findings, and a separate local commit. Later slices build on earlier completed slices.

Review depth scales with risk and is visible in the plan, with a user override. Small, low-risk tasks receive a short plan and an independent code review. Larger or riskier tasks receive independent plan review, reviews of individual slices, and a final integration review. For a one-slice task, its code review may also serve as its final review.

Prefer a different model family for independent review, such as Claude reviewing Codex. If that provider is unavailable, allow a fresh reviewer session with the same model and record the fallback. Reviewers inspect requirements, relevant code, and validation evidence independently.

Allow up to two review rounds before unresolved technical disagreements go to a fresh arbitrator. Blocking findings need concrete support, such as a failing case, violated requirement, or specific maintenance concern. Involve the user when arbitration remains unresolved or a decision requires their approval under the selected autonomy mode. Record findings, responses, decisions, and rationale.

## Quality requirements

Use shared baseline rules plus checks specific to the task. Repository conventions apply; the approved plan identifies additional validation appropriate to the change, such as regression tests, browser verification, output inspection, compatibility checks, or performance measurements.

The quality baseline is to keep changes focused, follow repository conventions and architecture, require meaningful validation, and review maintainability explicitly. Reviews should catch unnecessary abstractions, overcomplication, avoidable duplication, misleading or lazy names, weak tests, and architectural inconsistency.

Simplification is an explicit checkpoint:

1. During planning, check reuse of existing patterns and whether the approach needs its proposed abstractions.
2. Before each slice review, simplify changed code, inspect names and duplication, and assess whether tests demonstrate useful behavior.
3. During independent review, challenge complexity, architectural fit, and test quality.
4. During final integration review, check for duplication or inconsistencies across slices.

Simplification is focused on the task and directly affected surroundings by default. Record broader cleanup opportunities separately; broader refactoring may be enabled per task. Removing duplication does not automatically justify a new abstraction. Changes resulting from review or simplification require relevant validation again.

Passing tests and an agent's approval alone do not establish that acceptance criteria are satisfied. Verification must address the intended behavior and approved examples. Failed, skipped, or unavailable checks must remain explicit rather than being represented as passed.

## Effort and efficiency

The user-facing setting is Effort: Quick, Standard, or Thorough. Auto recommends a level at kickoff. Configurable presets map roles to agents, models, reasoning effort, context allowances, and retry limits, with optional per-role overrides. Selected settings are visible before approval.

Effort changes the resources used to meet the quality requirements; it does not waive required checks. Bounded escalation is allowed within an allowance visible at kickoff. Record the reason for escalation and ask before exceeding that allowance. Do not automatically enable paid API access.

Retry allowances scale with the preset. Stop and notify the user when the allowance is exhausted or attempts cease making progress. The two-round disagreement rule before arbitration remains applicable.

Use ordinary application code for scheduling, event recording, report rendering, and routine status handling. Avoid LLM polling and repeated narrative reconstruction. Supply relevant context and changes since the previous review while preserving access to the full requirements and necessary surrounding code. Reuse check results only while their inputs and dependencies remain valid. Avoid duplicate reviews when one can satisfy the same requirement.

Display usage when providers expose it. Distinguish measured usage, estimates, subscription allowances, and actual billed cost. Unknown usage must not be represented as zero. Exact numerical budgets and model mappings remain to be selected and validated.

## Observability and task history

Keep a durable local task journal that survives application restarts and worktree deletion. Meaningful steps include successful actions, failed attempts, reviews, checks, skipped work, decisions, approvals, commits, interruptions, and unresolved findings.

Entries identify the agent, model, role, action, outcome, brief rationale, and relevant evidence. Evidence may include diffs, commits, check output, review findings, artifacts, and retained session output. Record provisional decisions and disagreement resolutions explicitly. Distinguish agent-reported progress from verified results.

The dashboard presents a compact timeline with detail on demand, current slices, progress, decisions awaiting review, and an overview of other tasks needing attention. Generate final reports from the journal using templates rather than asking an agent to reconstruct the history. Support Markdown or HTML export. Repository copies of task documentation are optional, not the default.

Notify the user when input is required, work stops unexpectedly, or a task is ready for review. Routine progress and provisional decisions remain visible in the dashboard and report without interrupting the user. Out-of-boundary provisional decisions keep a persistent indication that acceptance is required.

## Delivery

Default delivery is local: independently reviewed slice commits, validation results, final verification, and a report of what changed and what remains unresolved. The user handles pushing and opening a PR.

An opt-in per-task mode pushes the branch, creates or updates a PR, checks CI, and addresses failures within scope. Automatic merging is not part of the agreed workflow.

Distinguish implementation finished, awaiting a decision, awaiting verification, and complete. Provisional changes requiring acceptance cannot silently become an approved final result.

## Proposed architecture

Use a local Grampus controller and durable storage for workflow policy, approvals, scheduling, history, checks, and reports. A browser-based dashboard provides the same interface inside Orca or in a normal browser. Shared agent instructions describe how Codex and Claude Code participate.

Keep the agent integration separate from workspace and host integration. A task should have one authoritative execution owner so Grampus and Orca do not independently schedule the same work.

| Environment | Integration direction |
| --- | --- |
| With Orca | Use Orca-managed worktrees and supported session/coordination interfaces; display Grampus in Orca's browser and connect the user to relevant work. Validate which session controls and evidence streams are available. |
| Without Orca | Manage Git worktrees directly and use supported agent interfaces. Provide conversation, approval, progress, and inspection access through Grampus and the user's preferred editor. |

This is a proposed integration boundary, not a completed compatibility guarantee. Runtime stack, storage format, installer, exact protocols, and session ownership mapping remain open implementation choices.

## Portability

Design installation, process handling, filesystem paths, notifications, and agent discovery for Windows, macOS, and Linux. Avoid hardcoded project paths, shell-specific orchestration, and assumptions that all platforms handle interruption identically.

Settings should be exportable, including effort presets, quality rules, and repository configuration. Resolve machine-specific checkout paths separately from portable project identity. Authenticate agents independently on each machine; do not include credentials in ordinary settings or history exports.

Proposed initial transfer behavior is explicit export/import of task state at a safe checkpoint, with repository and commit verification before resuming. An active process or provider session cannot be assumed transferable. Automatic synchronization and live task migration are not yet agreed requirements.

## Integration evidence

Orca supports custom sandboxed sidebar panels, but the public panel API reviewed exposes workspace context, terminal input, and notifications rather than complete orchestration and task-history access. Start with a browser dashboard; consider a native panel when a supported connection is available. Orca's plugin API is experimental.

- [Orca extension feature and sidebar panels](https://github.com/stablyai/orca/issues/6075)
- [Orca public plugin host API](https://github.com/stablyai/orca/blob/main/src/shared/plugins/plugin-host-api.ts)
- [Orca orchestration](https://www.onorca.dev/docs/orchestration)

Codex documents programmatic interfaces for task execution and interactive application integration. Claude Code documents programmatic execution and structured events. These support the direction of standalone execution, while authentication, interruption, recovery, effort settings, and usage reporting need verification for the installed agent versions and each supported platform.

- [Codex integration options](https://developers.openai.com/blog/codex-as-a-platform)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)

## Next design and validation work

- Select the smallest viable runtime, storage, and packaging approach for all three platforms.
- Validate one end-to-end task with both agents, including questions, review findings, interruption, and recovery, with and without Orca.
- Define the exact shared event format, approval versioning, completion checks, and handling of stale agent results.
- Specify how repository rules, existing skills, and task-specific checks are configured and applied.
- Choose initial effort mappings, concurrency limits, review budgets, and escalation allowances using measured pilot tasks.
- Confirm journal retention, artifact retention, and safe-checkpoint transfer behavior before promising unlimited history or seamless migration.
- Prototype the kickoff, plan approval, task timeline, decision review, and final evidence views before committing to a larger UI.
