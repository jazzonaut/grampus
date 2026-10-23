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

The initial target is zero technical interventions and a verified result within 30 minutes for
moderately sized tasks. This is an experimental target. A timeout is recorded as incomplete and does
not count as meeting the target merely because the driver stopped on time. The new policy has
deterministic regression coverage; improved real-model latency, cost and defect rates must still be
established through repeated runs.
