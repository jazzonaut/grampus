# Grampus design

> Product intent and the decisions behind it. Current behaviour is in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Unbuilt behaviour is marked **Planned**.

Grampus turns a plain-language coding request into a verified result. It runs a fixed,
measurable pipeline of coding agents on top of [Orca](https://www.onorca.dev/docs/orchestration)
and records enough evidence to tell whether a cheaper or faster pipeline did as well as an
expensive one.

This version replaces an earlier standalone controller (about 39,000 lines) that managed
providers, processes, worktrees and a SQLite journal itself. Orca's orchestration layer now
provides most of that, so Grampus keeps only what Orca does not: the pipeline, deterministic
verification, the evidence log and the measurements.

## Goals

1. **Agree the outcome before work starts.** A short spec with criteria, examples and the
   commands that prove it, approved by the user.
2. **Never take an agent's word for it.** Grampus runs the checks itself against the exact
   commit, and a model from the other family reviews the change.
3. **Save the user's attention.** Interrupt only for questions, approval, escalation and
   acceptance.
4. **Make pipelines measurable.** Every stage, check, finding, repair and human intervention
   is recorded so recipes can be compared on the same spec and base commit.

The longer-term aim is to recombine stages (tests first, review, repair, best-of-n, cascades)
so cheaper and faster models reach frontier-quality results. "Cheaper" means, in order:
subscription headroom (turns and tokens), wall-clock time to a verified result, and human
attention. API dollars are secondary.

## Decisions

| Decision | Why |
| --- | --- |
| Orca is required | Orca provides runs, task DAGs, dispatches, gates, questions, liveness and agent launch. Rebuilding them was most of the old code. |
| One deterministic driver per task, no LLM coordinator | Fixed pipelines match complex agent systems at a fraction of the cost, and a coordinator model spends tokens on bookkeeping. Judgement lives inside workers. |
| The driver runs in its own Orca terminal | An Orca terminal can coordinate exactly one Run, and Orca resolves caller identity from the terminal. The tab also shows the task's live log. |
| The driver is the only writer to its Run | The dashboard and CLI append commands to the task's queue; the driver applies them. No impersonated caller identities. |
| Orca owns lifecycle, Grampus owns evidence | Orca orchestration is marked experimental and does not record check results, findings or measurements. Grampus keeps an append-only event log per task. |
| Workers use Orca's chat or terminal, per the user's setting | Workers ask through Orca's `ask`, so every question reaches the user's control chat; the user never has to watch worker tabs. No chat UI in Grampus. |
| The builder commits; Grampus verifies that exact SHA | Simple and auditable. A dirty tree or a moved base fails verification. |
| A recipe is data | Stages, agents, models and effort are configuration, so experiments are recipe changes rather than code changes. |
| Control is chat first | Every decision is a CLI command, so a Claude or Codex chat in Orca with the Grampus skill can start tasks, relay what needs the user and queue their decisions. `grampus wait` blocks until something new needs the user, so watching costs no tokens. |
| The dashboard shows evidence and takes decisions | Timelines, check output, findings and scorecards, plus the same decisions as the CLI, queued for the driver. It is a local web app: Orca sidebar panels cannot reach a local server (`connect-src 'none'`) and expose only three actions. |
| The dashboard has no login | The user wants it on phones on the local network. Host, origin and framing guards stop other web pages from using it through a visitor's browser; anyone who can reach the port is trusted. |

## Default pipeline

```text
spec ─► spec review ─► [approve] ─► (tests first) ─► baseline ─► build ─► verify ─► review ─┐
                                                                              ▲              │
                                                                              └── repair ◄───┘
                                                         ready ─► [accept]
```

1. **Spec.** A worker investigates the repository, asks about consequential ambiguities through
   Orca's `ask` (the user answers from their control chat or the CLI), and writes a spec: outcome, acceptance
   criteria, concrete examples, exclusions, check commands and protected paths.
2. **Spec review.** Grampus first runs the spec's checks on the base commit, because a check that
   fails there for a reason other than the missing behaviour (no tests ran, a missing tool) can
   never pass, and that is cheapest to learn before anything is built. A worker from the other
   model family then reviews the spec, with those results, for gaps and ambiguity while the user
   reads it. Results and findings arrive as fresh approval requests when ready. They do not loop
   automatically.
3. **Approval.** An Orca gate blocks the build until the user approves this exact spec
   version, or asks for a revision. The approval request carries the spec text, its checks on the
   base commit and its review, so nobody is asked to approve a spec they have not been shown.
4. **Tests first** (optional per recipe, off by default). A worker turns the spec examples
   into failing acceptance tests and commits them. Those files become protected.
5. **Baseline.** The check results on the base commit, so failures that existed before the change
   are known before any repair. They are rerun only when tests first moved the commit.
6. **Build.** A worker implements the spec in the task worktree and commits on its branch.
7. **Verify.** Grampus checks that the tree is clean and the branch moved, guards protected
   files and tests against deletion or weakening, and runs every check at the head SHA. A
   failing check is rerun once; a pass on rerun is recorded as flaky.
8. **Review.** A worker from the other family reviews the diff against the spec and the
   check evidence. Only correctness or spec gaps with a location and a concrete failing
   scenario can block; "unknown" is allowed.
9. **Repair.** Failed checks, guard violations or blocking findings go to a repair worker.
   Actionable coverage gaps have a separate recipe allowance, `repair.coverageGapRounds`, set to
   three in both built-in recipes. They require a supported finding and known request coverage;
   uncertainty still escalates. Every attempt is checked and independently reviewed again.
   Round 1 continues the builder's conversation; later rounds start fresh with a distilled
   list of problems, because a long polluted context does worse. Grampus counts rounds
   itself; after the recipe's limit it escalates to the user.
10. **Polish** (optional per recipe, enabled in the standard recipes). Once a round is ready, a worker inspects it
    for improvements to readability, maintainability, consistency, simplicity and naming. Standalone
    improvements in any of these areas are welcome. The pass needs independent approval of safety
    and value. No worthwhile
    improvement is a successful no-op. Failed passes restore the verified commit without escalation
    or repair. Recorded restoration prevents a restart from resetting later rounds.
11. **Accept.** The user accepts the verified branch, gives guidance for another round, or
    abandons the task. Afterwards the user may ask Grampus to fast-forward their branch to the
    verified commit (`merge`). Pushing and opening a PR stay with the user.

Change understanding is optional review evidence. The user can request an explanation of the final
candidate or enable automatic generation per recipe. Purpose groups connect the original problem,
before and after behaviour, architecture, implementation decisions, validation and uncertainty to
committed lines. Questions gather understanding without requesting changes; explicit feedback is
collected and sent through the existing continuation decision. Results are bound to the candidate and
spec they discuss, so repairs cannot make earlier notes look current. Manual review marks help the
reader but do not gate acceptance. Grampus prepares editable PR copy; the user publishes it.

The builder never argues with the reviewer. A disputed finding is settled by a check, a fresh
review or the user, because judges flip verdicts under pushback.

## Guardrails

- Unknown is never success. A missing outcome, an uncertain dispatch or an unreadable report
  stops for the user.
- Never replay an uncertain mutation except by its recorded request id. Every Orca mutation
  carries a request id recorded before the call, and Orca answers a repeated id with the
  original receipt instead of acting twice. So the driver repeats an uncertain call a few times
  with the same id, which rides out an Orca restart, and stops for the user if it stays
  uncertain.
- Evidence is bound to a commit SHA and a spec version.
- Unknown measurements stay unknown; they never count as zero.

## Measurements

Each task records, from the first version:

- the recipe snapshot (stages, agents, requested and effective models, effort) and the Orca version;
- per dispatch: role, round, Orca task and dispatch ids, start and settle times, outcome and summary;
- per check: command, exit code, duration, timeout and flaky rerun, on both base and head SHAs;
- guard results: protected paths changed, test files deleted or modified;
- per review: verdict, findings with severity, location and scenario, and downgraded findings;
- repair rounds and why each one happened;
- every human intervention and how long the task waited for the user;
- final outcome: accepted, accepted with override, abandoned, or not selected (a comparison entry
  the user did not keep);
- token usage per dispatch from provider transcripts, and an estimated cost at API list prices.

Comparisons run one request under several recipes from the same base commit, one task per recipe.
In full mode each recipe writes its own spec, because spec quality is part of what a recipe buys, and
every result is then checked against every spec so a lax spec cannot flatter its own recipe. In shared
mode one approved spec isolates the build stages. The user keeps one entry; the others end as not
selected and their measurements still count.

**Planned:** JSON and CSV export, and a private evaluation set of 20 to 50 real tasks.

## Experiment order (Planned)

1. Frontier solo against cheap solo through the same pipeline, to measure the gap.
2. Frontier spec with a cheap builder.
3. Repair rounds 0, 1 and 2: verified results per unit of spend.
4. A cascade that escalates to a frontier builder when repair is exhausted.
5. Best-of-2 and best-of-3 cheap builders, selected by checks.
6. Reviewer: none, same family or other family, scored by confirmed findings.

Evidence is strongest for repeated sampling with execution-based selection and for scaffold
quality; it is weak for multi-agent debate and for mixing different models.

## Known limits

- Orca orchestration is experimental and changes quickly; re-check its contract on upgrades.
- Orca has no per-Run delete, so finished Runs remain in its history.
- Grampus does not see provider token counts directly yet.
- Execution is local; remote Orca servers are not supported.

## Workflow and comparison evidence

Repository setup runs before specification, with separate logs and explicit retries for failed or
interrupted attempts. Tests first accepts additions to existing test files, protects the resulting
tests, and records whether a claimed behavioural failure matches an independently observed log.
Shared comparisons distribute the same approved spec and acceptance-test commit to every builder.
Full comparisons preserve API incompatibility, execution errors and unknown results as distinct
outcomes; a failed copied test needs an approved portable interface to count as behavioural evidence.

Repository verification is a common baseline across recipes, snapshotted from the base commit and
included in each approved spec ahead of task-specific acceptance checks. Full comparisons bind each
cell to both the test-source and candidate commits and specifications. An entry change withdraws the
pick and refreshes affected evidence; a decision against an earlier comparison is refused. Shared
comparisons apply the same decision freshness rule. Passing an entry's own checks and review is
reported separately from cross-check outcomes.

The optional polish pass improves readability, maintainability, consistency, simplicity and naming.
Standalone improvements are welcome; no hypothetical future edit is needed to justify them. The worker
explains the issue and benefit, and independent review assesses both safety and whether the change is
worth keeping. Reports live in Git metadata
so they cannot enter the source diff. No worthwhile change is a successful no-op. Adjacent changes are bounded,
and uncertain or unsuccessful passes restore the verified commit without a repair loop. Final
verification, explanation, acceptance and cross-checks resolve the same retained candidate SHA.
Measurements separate setup, specification, tests, implementation, repair, polish, verification and
explanation; unknown cost, time and intervention attribution stay explicit.
