# Grampus — Product & Engineering Direction

**Working strategy and implementation proposal**  
**Prepared:** 18 October 2026  
**Status:** Proposed direction, not a claim that every capability is already implemented

## Executive summary

**Grampus should become a reliable, token-efficient execution and verification system for AI coding agents: one that minimizes human intervention, independently challenges generated code, makes its decisions understandable, and detects broken third-party integrations before they compromise delivery.**

The decisive product question is:

> **Does Grampus make building software materially better than using Codex or Claude directly?**

The answer must be demonstrated on real repositories, not assumed from successful orchestration fixtures. Grampus should compete on six measurable qualities:

1. **Bounded autonomy:** low-risk work proceeds from one approved plan to a verified local commit without repeated human intervention.
2. **Demonstrable correctness:** independent verification finds substantive defects and prevents regression, not merely produces reassuring green checks.
3. **Token and resource efficiency:** minimize total resources per *correctly accepted task*, including planning, implementation, reviews, repairs, repeated context and failed attempts.
4. **Integration resilience:** detect external CLI/SDK/protocol drift, report exactly which capabilities are affected, and fail safely until restored.
5. **Excellent, maintainable UI:** immediately readable state and next actions, with progressive disclosure into evidence, technical detail and forensics.
6. **Deep observability:** retain a correlated record of what happened, why it happened, what was observed, and what was uncertain—without indiscriminate secret capture or uncontrolled journal growth.

**The most important strategic guardrail: do not add infrastructure simply because it is interesting.** Reuse the existing controller, journals, capability checks, repository evidence and workflow gates. Prioritize improvements that demonstrably reduce human effort or increase trust.

---

## 1. Starting position: build on what Grampus already has

The supplied Grampus documentation describes a substantial implemented Windows-focused foundation:

- TypeScript/Node controller with SQLite-backed task state and append-only application events.
- Versioned plans and approval digests; isolated standalone Git or optional Orca workspaces.
- Codex and Claude integrations, repository exploration, explicit file scopes, supervised edits and commands.
- Separate simplification, validation, independent review, acceptance and local-commit delivery gates.
- Process leases, receipts, interruption and conservative restart recovery.
- A loopback local browser dashboard, CLI, installation snapshots, usage reporting and reports.
- Offline suites and live fixture probes that exercise important provider and workspace workflows.

The same documentation also identifies limitations: an early Windows alpha focus; mandatory manual checkpoints in the guided workflow; no general unattended multi-task scheduler; unresolved ordinary-project release validation; and external interfaces that could change. Recent documentation includes approved-plan revision, bounded repair/arbitration, expanded file-size handling, richer acceptance observations and ongoing integration tests. These existing capabilities should be extended, not mistakenly reinvented.

**Evidence note:** these are claims and results recorded in the supplied project documents, not an independent source-code audit or reproduction of the test suite.

**Relevant source documents:** `README.md`, `DESIGN.md`, `GUIDED-WORKFLOW.md`, `ARCHITECTURE.md`, `DASHBOARD.md`, `REPOSITORY-CONTEXT.md`, `RELEASE.md` and `INSTALLATION.md`.

---

## 2. Bounded autonomy: human approval for boundaries, not mechanics

A critical distinction: **a mandatory quality gate is not necessarily a mandatory human interaction**.

For a task whose outcome, scope, permissions and checks have been approved, routine execution should continue automatically while maintaining all safeguards. The controller—not a model's assertion—decides whether a gate has sufficient evidence to pass.

### Desired low-risk workflow

1. User describes the task; Grampus explores the pinned repository and asks only consequential clarification questions.
2. Grampus proposes a proportionate plan with intended behaviour, representative examples, selected agents, bounded file scope, checks, resource allowances and delivery method.
3. User approves the versioned plan and **delegated execution envelope**.
4. Grampus runs scoped implementation, preparation, validation, simplification assessment, independent review, bounded repair, acceptance and local-commit delivery.
5. User receives a clear completion summary and inspectable evidence; no further clicks are required when everything remains inside the agreed boundaries.

### Proposed gate ownership

| Gate or action | Low-risk default | Human intervention required when… |
| --- | --- | --- |
| Consequential requirement ambiguity | Ask before approval | Requested behaviour cannot safely be inferred |
| Plan and delegation envelope | Human approves once | Initial approval or material revision |
| Repository exploration | Automatic read within approved roots | New external access or boundary requested |
| File authorization | Delegated for exact approved paths/actions | New, expanded or sensitive write scope |
| Implementation and checks | Automatic under approved limits | Scope, process, policy or evidence is uncertain |
| Simplification assessment | Independent/automated assessment with retained reasoning and artifact evidence | Assessment is inconclusive, high-risk or policy requires a human |
| Independent review | Automatic | Blocking disagreement cannot be resolved within allowance |
| Repair attempts | Automatic within an approved maximum | Limit exhausted, requirements change or regression persists |
| Acceptance and local commit | Automatic only after existing evidence gates pass | Any missing, stale or conflicting evidence |
| Push, PR, merge, deployment, external writes | Separate explicit authorization | Not covered by the initial local-only envelope |

### Design rules

- The initial approval freezes the requirement version, task criteria, maximum scope, external-access capabilities, permitted commands, resource limits, review policy and delivery mode.
- Low-risk automation **must not** silently remove validation, review, simplification, acceptance, content-binding or recovery requirements.
- Any automatic simplification pass must be a genuine, recorded assessment by a policy-approved assessor; it must not be a fabricated pass based on an empty model response.
- Exact artifact/version checks stay authoritative. Every relevant modification after a pass invalidates the affected evidence.
- A stopped/unknown process never becomes 'success' because the controller restarted. Reconciliation does not replay uncertain inference or Git writes.
- Classify task risk explicitly; begin with narrow, trusted policies for small tasks. High-risk work remains more supervised.
- Distinguish **human interaction count** from **automated gate count**. Reducing the former must not dilute the latter.

**Target:** zero post-approval human interactions for an uneventful low-risk task that reaches a checked, locally delivered commit.

---

## 3. Prove correctness with adversarial evaluation

Grampus must earn its quality claim on **realistic defects that easy tests miss**.

### Build a versioned defect-injection benchmark

Create a small collection of ordinary-looking repositories or isolated branches with seeded, independently defined defects:

| Defect | Expected signal |
| --- | --- |
| Finite inputs that overflow during aggregation | Edge-case coverage and review challenge |
| Broad exception handling that conceals failures | Incorrect error semantics detected |
| A missing acceptance criterion hidden behind passing unit tests | Review or verification identifies inadequate oracle coverage |
| A public interface change that breaks callers | Integration test and independent review catch compatibility regression |
| A correct-looking repair that reintroduces an earlier bug | Regression and revalidation expose it |
| Superfluous abstractions, duplication or weak test assertions | Simplification/maintainability judgment with evidence |
| Behaviour that violates a concrete user example | Acceptance verification rejects result |

The benchmark should contain hidden, independently authored acceptance oracles. The agent writing the implementation should not simply write the only test by which it is judged.

### Compare fairly

Run Grampus with both provider pairings and compare against a direct Codex or Claude workflow with equivalent task instructions and available tools. Use repeated tasks/trials to reduce noise. Evaluate:

- **Correct delivery rate:** accepted by an external oracle, not merely by Grampus' generated checks.
- **Defect detection rate:** substantive seeded defects identified before delivery.
- **False-positive blocking rate:** reviewer objections that cannot be substantiated.
- **Repair quality:** fixes accepted without creating a new regression.
- **Human effort:** number of decisions and active intervention minutes.
- **Total time and resource use:** elapsed completion time, turns, tokens and measured provider usage.
- **Recovery and continuation:** safely completed tasks after realistic interruption.

Publish failures alongside successes. An autonomous tool that catches real mistakes and requires fewer interventions has a compelling reason to exist. One that merely adds more review stages does not.

---

## 4. Token and resource efficiency as a first-class property

**Optimize total effort per correctly accepted result—not minimum tokens for any one agent call.** A cheap prompt that causes rework is expensive.

### Operational principles

1. **Deterministic first.** Use ordinary code for scheduling, path validation, file hashing, state transitions, diff generation, checks, reporting, and anything else that does not require inference.
2. **Send minimum sufficient context.** Use Grampus' existing bounded repository exploration and paginated reads. Start from requirements and relevant files; expand only when evidence of relevance appears.
3. **Avoid repeated reconstruction.** Persist concise, authoritative task state and artifact identities instead of asking models to summarize the entire conversation again.
4. **Use artifact-focused review.** Supply current requirements, validated changes, tests and independently retrievable surrounding code; do not automatically replay a huge implementer transcript.
5. **Reuse valid results.** Cache/reuse deterministic evidence only while exact inputs, dependencies, configuration and task version remain unchanged.
6. **Make model selection proportional.** Use the existing Quick/Standard/Thorough direction to adjust effort, model routing, review depth and bounded repair allowances based on demonstrated risk.
7. **Don't multiply slices without benefit.** One small change should normally be one slice; additional slices must justify their incremental verification value.
8. **Record failure cost.** Include aborted turns, retries, planning turns, context refreshes and repairs in totals.
9. **Never infer unknown cost as zero.** Track measured usage, estimated cost and billed cost separately, respecting what subscriptions/providers do or do not expose.
10. **Separate budget controls from quality controls.** If a task needs more resources than authorized to meet mandatory checks, stop and request approval rather than quietly lowering the standard.

### Efficiency reporting

Show task-wide and by-stage usage: planning, implementation, review, repair, arbitration and optional naming. Include model/provider, input/output/cache-related tokens when exposed, observed coverage, turns, wall time, retries, failed attempts and human interventions. Allow comparison with a direct-agent baseline.

### Key questions to test

- Does a separate task-naming inference call provide enough value to justify itself?
- Which checks/reviews catch defects that would otherwise escape?
- Which context is repeatedly resent without adding value?
- Which provider/effort combination minimizes **accepted-task** cost for each risk class?
- Are aggressive context limits creating repairs, missed dependencies or longer elapsed time?

---

## 5. Resilience to Codex, Claude and other third-party changes

Grampus depends on external CLIs, SDKs, authentication, protocol events, model availability, MCP integrations, Git and optional Orca. A successful executable version check or handshake is **not** proof that editing, resumption and recovery still work.

### One authoritative health system, three levels

| Level | Checks | Inference / execution implications | When |
| --- | --- | --- | --- |
| **1. Environment** | Executables and versions, auth status, SDK/runtime compatibility, protocol handshake, journal/native helper readiness, configured MCP discovery | No model inference | Startup, before affected operations, version/config changes |
| **2. Capability smoke** | Real structured replies, repository read tools, scoped edit/create/delete, review responses, usage telemetry, cancellation/resumption | Minimal live subscription usage in isolated fixtures | Version changes, on demand, optional scheduled checks |
| **3. End-to-end compatibility** | Full local task with validation, review, repair, acceptance, interruption/recovery and verified commit | More expensive; isolated Git fixtures | Candidate upgrades and Grampus releases |

### Capability contracts and fingerprints

Maintain an explicit adapter capability contract (e.g. `conversation`, `structured_questions`, `repo_read`, `scoped_edit`, `review_findings`, `interrupt`, `resume`, `usage_events`). Store a fingerprint covering the external executable identity/version, pinned SDK dependency, relevant configuration, protocol expectations and tested capabilities. Treat model identity and model-dependent functionality as separate recorded inputs where relevant.

When the fingerprint changes:

1. Invalidate only relevant previously recorded confidence; distinguish **healthy**, **failed**, **untested on this version**, **not configured**, **auth unavailable** and **temporarily unavailable**.
2. Run inexpensive checks automatically. Queue or recommend live probes where required, clearly accounting for subscription usage.
3. **Fail closed for safety-critical capabilities.** Do not start unattended edits if their tool or process lifecycle contract is unknown. Permit unaffected read-only operations when safe.
4. Preserve diagnostic evidence: exact adapter, changed fingerprint, failing capability, error category, sanitized protocol excerpt and reproduction recipe.
5. Support explicit compatible-version pinning/rollback for dependencies under Grampus control; treat user-installed external CLIs as discovered dependencies unless Grampus actually manages them.

### CI and release compatibility matrix

- **Offline adapter contract tests:** recorded real protocol fixtures for supported versions, including malformed/unexpected events and reordered/optional fields.
- **Live provider probes:** opt-in or protected CI environment, authenticated separately, with bounded inference usage and no writes to real projects.
- **Fault injection:** controller crash before/after dispatch, uncertain PID/receipt, interrupted edits, auth loss and timeout or supervisor failure.
- **Upgrade canary:** validate candidate SDK/CLI versions against current supported ones before adopting a new default.
- **Compatibility report:** a clear pass/fail/untested matrix per provider version and capability, linked to reproducible test runs.

**Reliability promise:** external integrations can break; Grampus should detect, localize and explain the breakage quickly, avoid unsafe continuation and provide a clear patch/test path.

---

## 6. UI and UX: readable at a glance, detailed on demand

The interface should help answer, within seconds:

1. **What is Grampus doing right now?**
2. **Is everything healthy and moving forward?**
3. **Does anything need my decision?**
4. **What has been verified, and what is only agent-reported?**
5. **What did this task consume, and where can I inspect why?**

This should be a **command center for work and trust**, not a wall of status tables or a streaming terminal masquerading as a dashboard.

### Proposed frontend direction

Evaluate a staged redesign using **Vue 3 + TypeScript + Tailwind CSS + Nuxt UI** for consistent accessible components. Prefer **Vite with a client-rendered Vue application** over introducing a full Nuxt application unless SSR, filesystem routing or server-side Nuxt features have a demonstrated need. Confirm the chosen Nuxt UI package/version supports the planned Vue-only integration before committing.

The architectural boundary should remain:

- Existing **Node/TypeScript controller + SQLite journal** = authoritative workflow engine and policy enforcement.
- Frontend = presentation and user input through versioned, authenticated controller APIs; **never a second workflow engine**.
- Local **loopback-only** deployment, packaged static assets, no CDN requirement and the existing per-launch access controls must remain intact.
- Every mutation carries version/decision identity and is rejected when stale; the UI cannot bypass gates or silently replay operations.

### Information architecture

**A. Home / task overview (glanceable)**

- Overall health: ready, degraded, blocked or unknown, with a reason and affected capability.
- Active tasks: readable title, repository, current slice/stage, status, elapsed/last-activity time and current owner/provider.
- **Needs your attention** panel, first and visually distinct: questions, approval requests, failed checks, blocked recovery, resource-limit decisions.
- Recent verified deliveries: local commit and evidence summary; distinguish from ongoing/unverified changes.
- Task usage at a glance: token usage with completeness indicators, turns and human intervention count.
- Clear primary actions: **New task**, **Continue**, **Review decision**, **View result**. Avoid duplicated or disabled controls with unclear meaning.

**B. Task detail (progressive disclosure)**

1. **Summary header:** intended outcome, current status, one-sentence explanation, next automatic step or human action.
2. **Workflow strip:** plan → implement → validate → simplify → review → accept → deliver; show passed/pending/failed/unknown with actual evidence state.
3. **Current activity:** what agent/tool is doing, stage start, elapsed and last activity; explicitly avoid invented percentage progress.
4. **Decision queue:** only decisions requiring the user, including why, available safe choices, affected files/requirements and consequences.
5. **Results:** criteria coverage, check results, review findings, local commits and unresolved items.
6. **Usage:** provider/model breakdown and measured vs unknown values.
7. **Details on demand:** relevant diff, check output, approval digest, artifact hashes, prior attempts, full timeline, provider events and raw sanitized diagnostics.

**C. System health page**

- Providers, tools and MCP integrations with versions/fingerprints and per-capability status.
- What was tested and *when*; distinguish a passive version check from a real live smoke test.
- Failed contract tests, compatibility changes, safe retry options and related evidence.
- Warnings before launching tasks that depend on unverified capabilities.

**D. History / diagnostics**

- Task and provider timeline, searchable/filterable by stage, severity, agent, correlation ID, tool and decision.
- Reproduce-able event chain from user approval to tool request, observed result, evidence gate and final commit.
- Export a **sanitized support bundle** without manually trawling arbitrary log files.

### Visual/interaction design principles

- **Visual hierarchy over information quantity:** high-signal status and next action above raw details.
- **Progressive disclosure:** cards → expanded sections → full evidence view → raw diagnostic events.
- **Trustworthy status language:** clearly label *working*, *awaiting human*, *verified*, *failed*, *unknown* and *provider-reported*; never equate an agent's claim with a pass.
- **Accessible by default:** keyboard navigation, visible focus, meaningful labels, screen-reader status announcements, contrast, and avoid conveying state through colour alone.
- **Responsive layouts:** work comfortably at common laptop widths; dense technical panels should be resizable or collapsible rather than forcing horizontal scrolling.
- **Avoid noisy polling:** event updates where practical or revision-cached polling (already present), with rate limits and no inference caused by simply viewing a page.
- **No UI optimism on durable operations:** display requested/dispatching/settled state truthfully and reconcile from server authority.
- **Reveal why:** alongside every pause, retry, blocked action or changed plan, a human-readable explanation of the deciding policy/evidence.

### Incremental redesign; avoid a big-bang rewrite

1. Inventory current screens, API routes, users' recurring questions and common blockers.
2. Introduce design tokens, typography, spacing, status vocabulary and reusable components with accessibility baselines.
3. Move **one task view** to Vue without altering controller semantics; compare existing regression tests and user behaviour.
4. Build typed API clients and reusable view-model selectors; centralize state mapping rather than duplicating business rules in components.
5. Migrate task overview, health, history and diagnostics one screen at a time, retaining working rollback routes until stable.
6. Remove legacy UI code only after parity and regression/visual/accessibility verification.

**Do not rebuild the controller or database merely to use a fashionable frontend stack.** The value is readability and maintainability, not adopting Nuxt for its own sake.

---

## 7. Refactor for maintainability and change safety

Grampus already contains complex but important domain rules. The refactoring goal is to **make contracts explicit and ownership clear without weakening atomicity, recovery or content-binding**.

### Suggested boundaries

| Layer / module family | Responsibility | Explicitly should not do |
| --- | --- | --- |
| **Domain / workflow** | Task requirements, versions, state transitions, gate rules, policy decisions | Talk directly to Vue components or provider wire formats |
| **Orchestration** | Drive steps, coordinate leases, retries, bounded automation and human checkpoints | Invent success without domain evidence |
| **Provider adapters** | Codex/Claude protocol, SDK lifecycle, capability contracts, typed events | Own task approval or delivery truth |
| **Repository & process adapters** | Git/Orca workspaces, snapshots, native supervisor, receipts, recovery identities | Make business-level acceptance decisions |
| **Verification** | Artifact identity, check observations, independent review evidence, criterion mapping | Treat check exit 0 as proof of semantic sufficiency |
| **Persistence / diagnostics** | Transactional state, append-only events, correlation/causation, retention and export | Become an independent shadow state machine |
| **API / frontend** | Render authoritative state, gather decisions, progressively disclose evidence | Enforce workflow rules only in the client |

These are **logical boundaries first**. Do not split every file into packages or introduce dependency injection everywhere without evidence that doing so helps.

### Coding standards and patterns

- Strong TypeScript types and validated data at each external boundary; versioned schemas for journal payloads and provider events.
- Small, testable pure functions for transition guards, policy decisions, usage calculations and display selectors.
- Explicit discriminated states/results rather than ambiguous booleans; distinguish pending, failed, skipped, confirmed and uncertain.
- Adapters wrap unstable external SDK/CLI formats; domain rules depend on stable Grampus-owned contracts.
- Keep retries and idempotency boundaries centralized. A function that can dispatch an external side effect must have a recorded operation identity and recovery semantics.
- Avoid overabstracting common code: extract duplication only when the domain concept is truly shared.
- Preserve transactional state/event updates and content-bound evidence through every refactor.
- Establish module dependency rules, linting/formatting, test seams and architecture decision records for consequential changes.
- Test recovery of partially completed tasks, and that journals from other versions are refused unchanged. There is no backwards compatibility: one journal schema, one plan format and no migrations.
- Keep architecture documentation **current-state only**, with historical implementation notes archived separately; old 'not yet built' statements should not appear as current truth.

### Refactor validation

Use characterization tests around existing behaviour before moving code. Prioritize the hardest invariants: stale approvals, lease exclusivity, no replay after unknown dispatch, snapshot/check linkage, review/acceptance invalidation, and exact local-commit delivery. Add integration tests at adapters; use UI component and end-to-end tests for presentation/decision binding.

---

## 8. Diagnostic logging: record what happened **and why**

The existing SQLite journal should remain the **source of truth** for meaningful workflow events. Extend it to provide high-quality diagnostics rather than creating several disconnected competing logs.

The operating principle is:

> **Every consequential action, denial, transition, retry, external request, observed result and uncertainty should be explainable from a correlated event trail.**

Logging *everything* must not mean unlimited raw output, passwords, duplicated blobs or an unbounded performance tax.

### Minimum event envelope

For durable, consequential events, use a versioned structured schema such as:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "timestamp": "2026-10-18T20:00:00.000Z",
  "taskId": "task_...",
  "attemptId": "attempt_...",
  "operationId": "op_...",
  "correlationId": "trace_...",
  "causationId": "evt_parent_...",
  "source": "controller|codex|claude|git|check|ui",
  "type": "gate.decision",
  "status": "allowed|blocked|started|settled|failed|unknown",
  "reasonCode": "EVIDENCE_STALE",
  "reason": "Validation result does not match current artifact digest",
  "policyVersion": "policy_...",
  "artifactDigest": "sha256:...",
  "metadata": { "gate": "acceptance", "retryable": false },
  "evidenceRefs": ["evidence_..."]
}
```

Exact fields may differ, but use stable **event IDs, correlation IDs and causation IDs**. They make multi-process and cross-provider reconstruction possible after restart. Include wall-clock timestamps, plus monotonic durations where available, to avoid misleading ordering/duration from clock jumps.

### Event categories worth recording

- **User intent and decisions:** new brief, answered questions, approval version/digest, rejected stale clicks, revised scope, policy changes and explicit stops.
- **Orchestration decisions:** why a particular provider/model/effort was selected; why a gate was skipped, repeated, invalidated, passed or blocked; why an automatic repair or escalation was triggered.
- **Provider lifecycle:** adapter version/fingerprint, session/thread identity, connect/dispatch/stream/end, usage observations, interruptions, exit proof, malformed responses and capability mismatches.
- **Repository operations:** pinned base and workspace identities, file scope before/after, artifact digests, snapshots, checks, observed command exit/descendant settlement, staged and committed blob identity.
- **Quality and review:** criterion-to-check mapping, assessor/reviewer identity, findings, severity, supporting references, resolution and revalidation.
- **Recovery:** owner process identity, receipt state, verified facts, unknowns, why replay was refused, user-safe next actions.
- **Health checks:** what was checked, version/fingerprint, result, coverage, prior status and why a capability became unverified.
- **Performance/efficiency:** stage durations, retries, context sizes, token-usage snapshots, cache hits/misses when reliable, output truncation and resource limits.
- **Application errors:** categorized failures with stack/location in protected local diagnostics, not misleading 'generic failed' UI messages.

### Three diagnostic depths

1. **Operational events (default):** small, always-on, durable and queryable. Enough to reconstruct decisions, stages, outcomes and identities.
2. **Detailed evidence (retained by policy):** bounded tool arguments, command outputs, diffs, approved requirements, selected prompts/responses and artifact references where necessary for a task report or recovery.
3. **Verbose diagnostic trace (temporary/opt-in):** deeper adapter/protocol detail for reproducing specific integration issues; time-limited and clearly identified as potentially sensitive.

**Privacy and safety controls are mandatory.** Redact credentials, authorization headers, access tokens, provider secrets, personal identifiers where feasible, and sensitive environment variables. Treat code/prompts/task content as potentially confidential. Store only what is needed, classify data, set retention/size limits, support user-controlled export/purge policies consistent with durable recovery requirements, and never upload diagnostic bundles without an explicit user action.

Use bounded storage for large outputs and reference immutable artifacts by digest rather than repeatedly duplicating them in events. Never truncate evidence silently: record that truncation happened, the original size when known and whether the missing material invalidates a gate.

### Diagnosis UX: explain cause, not just error

When a task is blocked, a developer should see:

**Blocked: acceptance evidence is stale.**  
*Why:* `src/parser.ts` changed after the last passing check.  
*What was preserved:* the latest diff, provider session, recorded checks and workspace.  
*Safe next step:* rerun the relevant validation and independent review on the new artifact.  
*Technical details:* gate IDs, artifact digests, events and sanitized supervisor output.

### Support bundle

Offer **Export diagnostics** for a task or health failure. Include a manifest, application/provider versions, compatibility status, sanitized correlated events, failure chain, check summaries, evidence references and reproduction instructions. Provide an explicit content/privacy preview. It should be possible to report a problem without sharing the whole SQLite database or leaking repository secrets.

---

## 9. A unified testing and quality strategy

| Layer | Tests | What they prove |
| --- | --- | --- |
| Domain/state | Unit tests and property-based transition cases | Invalid versions/evidence cannot bypass gates |
| Controller/persistence | SQLite and crash/restart integration | Atomicity, durable state, lease/recovery invariants |
| Provider adapters | Fixture/schema and live capability contract tests | External events and lifecycle still match assumptions |
| Repository/process | Real disposable Git worktrees and fault injection | Write scope, descendant settlement, receipts and delivery integrity |
| Frontend | Vue component, accessibility and browser E2E tests | Readable, correctly bound decisions and states |
| Verification efficacy | Seeded defect benchmark with hidden oracles | Reviews/checks find real mistakes |
| Product value | Direct-agent versus Grampus comparative tasks | Less human effort, good outcomes, resource efficiency |

Tests should distinguish **offline simulated evidence** from **real provider integration** and **ordinary-project evidence**. Reports must say exactly what was and was not tested.

---

## 10. Recommended implementation sequence

Prioritize proof of value and controlled reduction of friction, not feature count.

### Phase 0 — Measure current behaviour

**Deliverables:** baseline dashboard metrics, intervention counter, per-stage resource usage, a small real-project task corpus and a list of the most expensive/annoying manual gates.

**Exit condition:** we can quantify today's human involvement, failure causes, accepted quality and resource usage without relying on anecdotes.

### Phase 1 — Contracts, health and logging foundations

**Deliverables:** unified adapter capability schema, version fingerprints, health matrix, correlation/causation IDs, reason-coded controller decisions, redaction and bounded diagnostic export. Reuse existing `doctor`, probes and journal rather than replacing them.

**Exit condition:** a simulated external protocol change is detected; affected operations are held safely; a support bundle makes the failure reproducible.

### Phase 2 — Low-touch execution within approved boundaries

**Deliverables:** delegated file/operation envelope, approved low-risk autonomy policy, automatic honest simplification assessment, bounded repair continuation and actionable pause handling.

**Exit condition:** a meaningful low-risk task reaches reviewed, accepted local delivery after initial approval without additional human action, while negative tests still prove gates cannot be bypassed.

### Phase 3 — Interface and maintainability modernization

**Deliverables:** typed controller API, Vue 3/Tailwind/Nuxt UI proof of concept, current task summary, attention queue, workflow/evidence display, health view, progressive diagnostics and clearer module boundaries. Stage the migration; preserve the existing controller and journal.

**Exit condition:** a new user can tell what Grampus is doing, what needs their attention, what is verified and why an operation stopped—without interpreting raw journal internals. UI tests and accessibility checks pass.

### Phase 4 — Prove correctness and efficiency

**Deliverables:** versioned seeded-defect suite, independent hidden oracles, direct-agent baselines and analyses of token/latency/review trade-offs. Add optimization policies only after measurements identify waste.

**Exit condition:** comparative evidence demonstrates whether Grampus improves accepted outcomes and human effort without excessive resource overhead; unsuccessful cases are documented.

### Phase 5 — Release confidence and ecosystem maintenance

**Deliverables:** CI provider compatibility matrix, upgrade canaries, documented recovery/rollback paths, clean Windows distribution testing and subsequent cross-platform validation as scoped.

**Exit condition:** Grampus upgrades and provider changes have a repeatable, auditable path from detection to test to patch to verified release.

*Sequencing note:* UX prototype work can begin early; however, major UI rewrites should not block real-project trials. Logging, health contracts and measurements should be introduced incrementally rather than as a large parallel framework.

---

## 11. Product success measures

Set numerical targets only after establishing a real baseline. Proposed directional criteria:

| Goal | Measure | Desired direction / condition |
| --- | --- | --- |
| Autonomy | Human interventions after initial approval for successful low-risk work | **Zero** in the normal case |
| Correctness | Independent acceptance success and seeded-defect catch rate | Higher than direct-agent baseline, without high false-positive blocking |
| Safety | Mandatory gate violations / unauthorized modifications | **Zero tolerated**; continuously regression-tested |
| Efficiency | Total measured resource usage per independently accepted result | Lower or clearly justified by better outcomes |
| Time | Active human minutes and wall time to verified delivery | Lower active human time; track latency separately |
| Robustness | External breaking changes caught before affected unattended execution | All tested critical capability changes cause appropriate revalidation/blocking |
| Recoverability | Interrupted tasks that can be safely understood and continued | Improving, with uncertainty preserved instead of invented success |
| UX | Time to identify state, next action, reason and evidence | Seconds rather than hunting through raw logs |
| Maintainability | Time to isolate and patch adapter/UI/domain regressions | Shorter, aided by contracts, tests and correlated diagnostics |
| Observability | Consequential decisions with source, reason and evidence linkage | Near-complete, without exposing secrets or bloating storage |

Measure at task level and compare against the same real tasks performed directly with Codex or Claude. Different models, prompts, repositories and hidden oracles must be controlled or reported so that comparisons are interpretable.

---

## 12. Non-negotiable architectural guardrails

1. **Controller owns truth.** A model reply, UI status or provider event never directly authorizes completion.
2. **Verification stays artifact-bound.** Evidence cannot be reused after relevant state changes.
3. **Unknown is not success.** No automatic replay of uncertain external actions; confirmed process settlement remains distinct from a stop request.
4. **Delegation is explicit and bounded.** Autonomous continuation uses the user's approved authority; external writes need separate authorization.
5. **Efficient does not mean less safe.** Token optimization cannot silently waive mandatory checks.
6. **Provider boundaries are adapters.** External changes should be localized behind typed, testable contracts.
7. **Frontend is a view, not a second orchestrator.** Same policies and decision identities apply through UI and CLI.
8. **Observability is truthful and private.** Explain what and why; distinguish measured, inferred, agent-reported, unknown and omitted evidence.
9. **Refactor incrementally.** Preserve crash recovery and the known working paths while improving structure.
10. **Measure the user outcome.** Successful orchestration is necessary, but value means better accepted code with less human work and proportionate resources.

## Closing direction

There are still two possible futures for Grampus:

**Successful:** a trusted local execution layer that accepts clear goals and approved limits, coordinates independent implementation and review, verifies results, conserves resources, and remains debuggable through external tool changes—all through a UI that is immediately understandable.

**Unsuccessful:** a sophisticated workflow engine that demands repeated human involvement, accumulates excessive abstraction and logs, and delivers little additional value compared with a developer operating their preferred coding agent directly.

The path toward the first is not to add more agents or more buttons. It is to **remove needless human work, prove that verification catches mistakes, account for resource usage, harden integration seams, make the UI a calm and useful operational cockpit, and ensure every important decision is explainable from reliable evidence.**

That is the Grampus worth building—and, importantly, a Grampus whose advantage can be measured.
