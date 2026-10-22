// The pipeline a task follows: spec and approval, optional tests first, baseline checks, then rounds of
// build or repair, verification, review and a decision, until the user accepts or abandons. Each step
// returns early when the log already records it, so a restarted driver resumes at the first missing step.
import { join } from 'node:path';
import { runChecks, logExcerpt } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import { judgeCodeReview, parseReviewReport } from '../domain/review.js';
import { repairAssignment, type Assignment } from '../domain/recipe.js';
import type { GuardResult, TaskOutcome, UserCommand } from '../domain/events.js';
import { changedPaths, headSha } from '../git/git.js';
import type { DriverCore, Launch, Settled } from './driver-core.js';
import { measureDispatches } from '../measure/usage.js';
import { inspectCandidate } from './guard.js';
import { buildPrompt, repairPrompt, reviewPrompt, testsFirstPrompt, type RepairProblems } from './prompts.js';
import { approveSpec, ensureGate } from './spec-phase.js';
import { currentDispatch, grantedRounds, stageKey, type SpecVersion } from './state.js';
import { approvedSpecPath, excludeWorkerFolder, keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';

/** Run the task to acceptance. Throws `TaskAbandoned` or `DriverStop` to end early. */
export async function runPipeline(core: DriverCore): Promise<void> {
  const worktree = core.state.workspace?.path;
  if (!worktree) throw new Error('The task has no worktree.');
  await excludeWorkerFolder(worktree);
  await ensureRun(core);
  // An inherited spec was approved in the sibling that wrote it; there is nothing to gate here.
  if (!core.state.inherited) await ensureGate(core);
  const spec = await approveSpec(core, worktree);
  await testsFirst(core, worktree, spec);
  await baseline(core, worktree, spec);
  let guidance: string | null = null;
  for (let round = 0; ; round++) {
    const settled = await buildRound(core, worktree, spec, round, guidance);
    await verify(core, worktree, spec, round);
    await review(core, worktree, round);
    const decision = decideRound(core, round, settled);
    if (decision === 'repair') {
      guidance = null;
      continue;
    }
    const choice = await askUser(core, round, decision);
    if (choice.kind === 'accept') return finish(core, 'accepted', decision === 'escalate', null);
    guidance = choice.kind === 'continue' ? choice.guidance : null;
  }
}

async function ensureRun(core: DriverCore): Promise<void> {
  const here = process.env.ORCA_TERMINAL_HANDLE ?? null;
  if (core.state.runId) {
    const created = core.events.find(event => event.type === 'run.created');
    // An Orca terminal coordinates one Run; a driver restarted in another terminal must rebind it.
    if (created?.type === 'run.created' && here && created.coordinatorHandle !== here)
      await core.orca.useRun(core.state.runId);
    return;
  }
  const run = await core.mutate(() => core.orca.createRun(`Grampus: ${core.state.title}`, core.requestId('run')));
  core.record({ type: 'run.created', runId: run.runId, coordinatorHandle: run.coordinatorHandle });
  core.log(`Orca run ${run.runId} created.`);
}

/** Optional acceptance tests written before the build. Their files become protected. */
async function testsFirst(core: DriverCore, worktree: string, spec: SpecVersion): Promise<void> {
  const assignment = core.state.recipe.testsFirst;
  if (!assignment || core.state.testsFirst) return;
  const fromSha = core.state.workspace?.baseSha ?? (await headSha(worktree));
  const settled = await core.runStage({
    key: stageKey('tests', 0),
    stage: 'tests',
    round: 0,
    title: `Acceptance tests: ${core.state.title}`,
    spec: () => testsFirstPrompt({ specPath: approvedSpecPath(worktree), checks: spec.checks }),
    launch: { assignment },
  });
  const sha = await headSha(worktree);
  const added = (await changedPaths(worktree, fromSha, sha))
    .filter(change => change.status === 'A')
    .map(change => change.path);
  if (settled.outcome === 'failed' || added.length === 0) {
    const detail = settled.outcome === 'failed' ? settled.body : 'no test files were committed';
    await core.decide('tests-failed', `Tests first did not produce tests: ${detail}. Continue without them?`, [
      'continue',
      'abandon',
    ]);
  }
  core.record({ type: 'tests.recorded', sha, files: added });
}

/** Run the checks before the build so failures that already existed are known. */
async function baseline(core: DriverCore, worktree: string, spec: SpecVersion): Promise<void> {
  if (core.state.baseline) return;
  const sha = await headSha(worktree);
  core.log('Running baseline checks.');
  const results = await runChecks(worktree, spec.checks, core.store.checksDir('baseline', 0), { rerunFailures: false });
  core.record({ type: 'checks.recorded', phase: 'baseline', round: 0, sha, results });
  core.log(
    `Baseline: ${results.filter(result => result.passed).length}/${results.length} checks pass before the change.`,
  );
}

/** The commit a round starts from: the baseline for the build, the previous candidate for a repair. */
function roundStart(core: DriverCore, round: number): string {
  const sha = round === 0 ? core.state.baseline?.sha : core.state.guard.get(round - 1)?.sha;
  if (!sha) throw new Error(`Round ${round} has no starting commit.`);
  return sha;
}

function protectedFiles(core: DriverCore): string[] {
  return core.state.testsFirst?.files ?? [];
}

function buildRound(
  core: DriverCore,
  worktree: string,
  spec: SpecVersion,
  round: number,
  guidance: string | null,
): Promise<Settled> {
  const recipe = core.state.recipe;
  const protectedPaths = [...spec.protected, ...protectedFiles(core)];
  const specPath = approvedSpecPath(worktree);
  if (round === 0)
    return core.runStage({
      key: stageKey('build', 0),
      stage: 'build',
      round: 0,
      title: `Build: ${core.state.title}`,
      spec: () => buildPrompt({ specPath, checks: spec.checks, protectedPaths }),
      launch: { assignment: recipe.build },
    });
  return core.runStage({
    key: stageKey('repair', round),
    stage: 'repair',
    round,
    title: `Repair ${round}: ${core.state.title}`,
    spec: () =>
      repairPrompt({
        specPath,
        checks: spec.checks,
        protectedPaths,
        round,
        problems: problemsOf(core, round - 1, guidance),
      }),
    launch: repairLaunch(core, round),
  });
}

/** Early repair rounds continue the builder's conversation; later ones start fresh with distilled problems. */
function repairLaunch(core: DriverCore, round: number): Launch {
  const recipe = core.state.recipe;
  const assignment = repairAssignment(recipe);
  const previousKey = round === 1 ? stageKey('build', 0) : stageKey('repair', round - 1);
  const previous = currentDispatch(core.state.stages.get(previousKey));
  const sameModel = sameAssignment(assignment, recipe.build);
  if (previous && sameModel && round <= recipe.repair.reuseBuilderRounds)
    return { reuse: previous, fallback: assignment };
  return { assignment };
}

function sameAssignment(left: Assignment, right: Assignment): boolean {
  return left.agent === right.agent && left.model === right.model && left.effort === right.effort;
}

function problemsOf(core: DriverCore, round: number, guidance: string | null): RepairProblems {
  const baselineFailures = new Set(
    core.state.baseline?.results.filter(result => !result.passed).map(result => result.name),
  );
  return {
    failedChecks: (core.state.verify.get(round)?.results ?? [])
      .filter(result => !result.passed)
      .map(result => ({
        result,
        excerpt: logExcerpt(result.logPath),
        failedAtBase: baselineFailures.has(result.name),
      })),
    violations: core.state.guard.get(round)?.guard.violations ?? [],
    findings: core.state.reviews.get(round)?.blocking ?? [],
    guidance,
  };
}

async function verify(core: DriverCore, worktree: string, spec: SpecVersion, round: number): Promise<void> {
  if (!core.state.guard.has(round)) {
    const fromSha = roundStart(core, round);
    const sha = await headSha(worktree);
    const guard = await inspectCandidate({
      cwd: worktree,
      fromSha,
      sha,
      protectedGlobs: spec.protected,
      protectedFiles: protectedFiles(core),
      testPatterns: currentSettings().testFilePatterns,
      checkConfigPatterns: currentSettings().checkConfigPatterns,
      checkCommands: spec.checks.map(check => check.command),
    });
    core.record({ type: 'guard.recorded', round, fromSha, sha, guard });
    if (guard.violations.length) core.log(`Guard: ${guard.violations.join('; ')}`);
  }
  if (core.state.verify.has(round)) return;
  const sha = core.state.guard.get(round)?.sha ?? (await headSha(worktree));
  core.log(`Running checks at ${sha.slice(0, 12)}.`);
  const results = await runChecks(worktree, spec.checks, core.store.checksDir('verify', round), {
    rerunFailures: true,
  });
  core.record({ type: 'checks.recorded', phase: 'verify', round, sha, results });
  core.log(`Checks: ${results.filter(result => result.passed).length}/${results.length} pass.`);
}

async function review(core: DriverCore, worktree: string, round: number): Promise<void> {
  const assignment = core.state.recipe.review;
  if (!assignment || core.state.reviews.has(round)) return;
  const key = stageKey('review', round);
  const reportPath = workerFile(worktree, key, 'report.json');
  const candidate = core.state.verify.get(round);
  const guard = core.state.guard.get(round);
  if (!candidate || !guard) throw new Error(`Round ${round} has no verified candidate to review.`);
  const settled = await core.runStage({
    key,
    stage: 'review',
    round,
    title: `Review ${round}: ${core.state.title}`,
    spec: () =>
      reviewPrompt({
        specPath: approvedSpecPath(worktree),
        baseSha: roundStart(core, 0),
        sha: candidate.sha,
        reportPath,
        results: candidate.results,
        modifiedTests: sinceBuild(core, round, result => result.modifiedTests),
        modifiedCheckConfig: sinceBuild(core, round, result => result.modifiedCheckConfig ?? []),
        previousFindings: round > 0 ? (core.state.reviews.get(round - 1)?.blocking ?? []) : [],
      }),
    launch: { assignment },
  });
  try {
    if (settled.outcome === 'failed') throw new Error(`The reviewer reported failure: ${settled.body}`);
    const text = readWorkerFile(reportPath);
    if (text === null) throw new Error(`No review report was written at ${reportPath}.`);
    const outcome = judgeCodeReview(parseReviewReport(text));
    keepEvidence(reportPath, join(core.store.dir, 'reviews', `round-${round}.json`));
    core.record({
      type: 'review.recorded',
      round,
      sha: candidate.sha,
      report: outcome.report,
      blocking: outcome.blocking,
      downgraded: outcome.downgraded,
      error: null,
    });
    core.log(
      `Review: ${outcome.report.verdict}, ${outcome.blocking.length} blocking, ${outcome.downgraded.length} downgraded.`,
    );
  } catch (error) {
    core.record({
      type: 'review.recorded',
      round,
      sha: candidate.sha,
      report: null,
      blocking: [],
      downgraded: [],
      error: (error as Error).message,
    });
    core.log(`Review unavailable: ${(error as Error).message}`);
  }
}

/** Starts the decision reason that carries the builder's own report, so views can show that report apart. */
export const builderFailed = 'the builder reported failure: ';

/** Decide a round from recorded evidence: ready, another repair round, or escalation to the user. */
function decideRound(core: DriverCore, round: number, settled: Settled): 'repair' | 'escalate' | 'ready' {
  const recorded = core.state.decisions.get(round);
  if (recorded) return recorded.decision;
  const problems: string[] = [...(core.state.guard.get(round)?.guard.violations ?? [])];
  for (const result of core.state.verify.get(round)?.results ?? [])
    if (!result.passed) problems.push(`check "${result.name}" failed${result.timedOut ? ' (timed out)' : ''}`);
  const reviewed = core.state.reviews.get(round);
  for (const finding of reviewed?.blocking ?? []) problems.push(`blocking finding: ${finding.title}`);
  // Problems only a person can resolve: more rounds would repeat them.
  const stoppers: string[] = [];
  if (settled.outcome === 'failed') stoppers.push(`${builderFailed}${settled.body}`);
  if (reviewed?.error) stoppers.push(`review unavailable: ${reviewed.error}`);
  const allowed = core.state.recipe.repair.maxRounds + grantedRounds(core.state);
  const decision = stoppers.length ? 'escalate' : !problems.length ? 'ready' : round < allowed ? 'repair' : 'escalate';
  core.record({ type: 'round.decided', round, decision, reasons: [...stoppers, ...problems] });
  core.log(
    `Round ${round}: ${decision}${problems.length + stoppers.length ? ` (${[...stoppers, ...problems].join('; ')})` : ''}.`,
  );
  return decision;
}

function askUser(core: DriverCore, round: number, decision: 'escalate' | 'ready'): Promise<UserCommand> {
  const sha = core.state.verify.get(round)?.sha.slice(0, 12) ?? 'unknown';
  const reasons = core.state.decisions.get(round)?.reasons ?? [];
  const verdict = core.state.reviews.get(round)?.report?.verdict;
  if (decision === 'ready')
    return core.decide(
      `ready:${round}`,
      `Verified at ${sha}: every check passes${verdict ? `, review ${verdict}` : ', no review'}.${baselineNote(core)}${checkConfigNote(core, round)} Accept, continue with guidance, or abandon.`,
      ['accept', 'continue', 'abandon'],
    );
  return core.decide(
    `escalate:${round}`,
    `Round ${round} needs you at ${sha}: ${reasons.join('; ')}.${checkConfigNote(core, round)} Continue with guidance, accept anyway, or abandon.`,
    ['continue', 'accept', 'abandon'],
  );
}

/**
 * Checks that already passed before the change show that nothing regressed, not that the new behaviour
 * works; for those, only the review vouches for the change. Say so when asking for acceptance.
 */
function baselineNote(core: DriverCore): string {
  const passedBefore = (core.state.baseline?.results ?? []).filter(result => result.passed).map(result => result.name);
  if (!passedBefore.length) return '';
  const all = passedBefore.length === core.state.baseline?.results.length;
  return ` Note: ${all ? 'every check' : `check ${passedBefore.map(name => `"${name}"`).join(', ')}`} also passed before the change, so the checks show no regression but do not demonstrate the new behaviour.`;
}

/**
 * A change to how checks run can make them pass without the behaviour, and no check would notice; only
 * the review and the user can. Named across every round, since the decision is about the whole change.
 */
function checkConfigNote(core: DriverCore, round: number): string {
  const changed = sinceBuild(core, round, result => result.modifiedCheckConfig ?? []);
  if (!changed.length) return '';
  return ` Note: check configuration changed since the build started: ${changed.join(', ')}. Make sure it does not make a check pass without the behaviour.`;
}

/**
 * Paths a guard list names in any round up to `round`. The reviewer and the user judge the whole change
 * since the build started, while each guard record covers one round.
 */
function sinceBuild(
  core: DriverCore,
  round: number,
  pick: (guard: GuardResult) => readonly string[] | undefined,
): string[] {
  const paths = new Set<string>();
  for (let earlier = 0; earlier <= round; earlier++) {
    const guard = core.state.guard.get(earlier)?.guard;
    for (const path of (guard && pick(guard)) ?? []) paths.add(path);
  }
  return [...paths];
}

/** Release the workers and record the outcome. */
export async function finish(
  core: DriverCore,
  outcome: TaskOutcome,
  override: boolean,
  reason: string | null,
): Promise<void> {
  if (core.state.finished) return;
  await core.releaseWorkers();
  // Measured after release so every worker's final turn is in its transcript.
  if (!core.state.measurements)
    core.record({ type: 'usage.recorded', measurements: await measureDispatches(core.state, core.orca) });
  const worktree = core.state.workspace?.path;
  const sha = worktree ? await headSha(worktree).catch(() => null) : null;
  core.record({ type: 'task.finished', outcome, sha, override, reason });
  core.log(`Task ${outcome}${override ? ' with unresolved problems' : ''}${sha ? ` at ${sha.slice(0, 12)}` : ''}.`);
}
