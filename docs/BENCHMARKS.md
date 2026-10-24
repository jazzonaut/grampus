# Comparing cost, quality and autonomy

Optimise cost per independently verified result, including failed attempts, rather than tokens or
the price of the first build. A cheaper builder with more recovery can be a good result; a cheap
incomplete branch is not equivalent to an accepted one.

Use `compare --mode shared` for builder experiments. It is the CLI and dashboard default. Freeze the
repository base, request, required checks and public behavioural contract. Enable `testsFirst` in the
lead recipe to share its immutable acceptance-test commit, or commit a common `behaviouralHarness`
before the comparison. Shared mode alone shares the spec; it does not invent a shared test suite.
Use stable production interfaces, rather than new private hooks or simulation fields. Keep full mode
for whole-workflow experiments, where specification quality and test compatibility are also variables.

Start with standard versus adaptive recipes. To isolate model price, copy a standard recipe and change
only build and repair assignments, removing fallback. Keep reviewer strength, verification, budgets
and optional stages fixed. Do not interpret an adaptive success as proof that the cheaper model alone
solved the task. Recipe snapshots, not just names, define an experimental condition.

Repeat each condition across several tasks and seeds or fresh runs. Include ordinary edits, stateful
integration work, a failing test, a missing tool, malformed reports and an ambiguous product request.
Keep hidden regression scenarios independent of the builder's tests. Review all resulting branches
against the same acceptance contract, including ones that were not selected.

For controlled latency measurements, finish Grampus's own verification before launch and keep other
machine workloads comparable. If development checks overlap a live run, record that contention as a
timing limitation. The Windows test runner caps concurrent test files at two because four competing
Git-heavy files exhausted observation deadlines during live benchmarks; assertions and delivery
budgets are unchanged.

Export `grampus report <task> --json` and compare:

- Verified completion rate, including incomplete and abandoned runs in the denominator.
- Total known estimated spend across every attempt divided by verified completions. If any costs
  are missing, report a partial total and unknown count; do not publish it as a complete cost ratio.
- First and latest verified-candidate latency, separately from selection wait and worker launch time.
- External interventions, including chat guidance; automatic corrections, answers and investigations.
- Model escalations and reopened ready results. A later defect invalidates any claim of first-pass
  correctness even though historical first-readiness timing remains recorded.
- Defects found by the common held-out tests or subsequent use. No new evidence means unknown,
  not zero escaped defects.

The initial target is zero technical interventions and a verified result within 60 minutes for
moderately sized tasks. This is an experimental target. A timeout is recorded as incomplete and does
not count as meeting the target merely because the driver stopped on time. The new policy has
deterministic regression coverage; improved real-model latency, cost and defect rates must still be
established through repeated runs.

For PlayBeam unattended-delivery experiments, use `standard-codex,adaptive-codex` with
`--mode full --delivery unattended --max-seconds 3600`. Each entry must establish its own spec and
verified implementation; one entry's planning failure must not prevent the other from starting.
Full mode's final cross-check distinguishes incompatible tests from demonstrated behavioural failure.
For a separate builder experiment, use shared mode with `--shared-tests` and record the lead entry's
specification/test-authoring overhead separately. Shared preparation is a dependency of both entries,
so a blocked lead provides no measurement of the follower's delivery capability. Adaptive fallback
remains a mixed-model condition. Earlier outcomes remain historical results against their original
policies, prompts and limits. Do not overwrite a running snapshot or silently extend a failed budget.

For the four-recipe polish experiment, compare `standard-codex,adaptive-codex,standard-codex-polish,adaptive-codex-polish`
with the same full-mode policy above. Both polish variants use `gpt-6.1-sol` at medium effort and keep
all other assignments and allowances from their parent recipe. Polish consumes the same 60-minute
budget, including checks and independent maintenance review. Record each pass as kept, no-op or
discarded and retain its pre-polish commit for a paired assessment; independently generated candidates
alone cannot isolate polish's effect. Finish development checks before launching measured workers.
