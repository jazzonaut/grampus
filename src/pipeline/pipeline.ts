// The pipeline a task follows: spec and approval, optional tests first, baseline checks, then rounds of
// build or repair, verification, review and a decision, until the user accepts or abandons. Each step
// returns early when the log already records it, so a restarted driver resumes at the first missing step.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runChecks, logExcerpt } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import { checkDeadline, deliverySignal, deliveryPolicy, policyDecision, selectedRepairAssignment } from './delivery.js';
import { executeReviewProbes, reviewWorkspace } from './review-workspace.js';
import {
  judgeCodeReview,
  parseReviewReport,
  validateCoverage,
  coverageProblems,
  unresolvedConcerns,
} from '../domain/review.js';
import type { Assignment } from '../domain/recipe.js';
import type { GuardResult, TaskOutcome, UserCommand } from '../domain/events.js';
import { changedPaths, headSha, git, uncommittedPaths } from '../git/git.js';
import { matchesAny } from '../util/glob.js';
import { finalCandidate } from './candidate.js';
import { assertEvidenceUnchanged, evidenceSnapshot } from './evidence.js';
import { DriverStop } from './driver-core.js';
import { prepareWorkspace } from './setup.js';
import { retainReviewProbes } from './review-probes.js';
import { recordTestBaseline, testBaselineNote } from './test-evidence.js';
import type { DriverCore, Launch, Settled } from './driver-core.js';
import { measureDispatches } from '../measure/usage.js';
import { inspectCandidate } from './guard.js';
import { buildPrompt, repairPrompt, reviewPrompt, testsFirstPrompt, type RepairProblems } from './prompts.js';
import { polish, polishNote } from './polish.js';
import { approveSpec, ensureGate } from './spec-phase.js';
import { currentDispatch, stageKey, type ReviewRecord, type SpecVersion } from './state.js';
import { approvedSpecPath, excludeWorkerFolder, keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';

/** Run the task to acceptance. Throws `TaskAbandoned` or `DriverStop` to end early. */
export async function runPipeline(core: DriverCore): Promise<void> {
  const worktree = core.state.workspace?.path;
  if (!worktree) throw new Error('The task has no worktree.');
  await excludeWorkerFolder(worktree);
  await ensureRun(core);
  await prepareWorkspace(core, worktree);
  // An inherited spec was approved in the sibling that wrote it; there is nothing to gate here.
  if (!core.state.inherited) await ensureGate(core);
  const spec = await approveSpec(core, worktree);
  await testsFirst(core, worktree, spec);
  await baseline(core, worktree, spec);
  recordTestBaseline(core, worktree);
  for (let round = 0; ; round++) {
    const settled = await buildRound(core, worktree, spec, round);
    await verifyAndReview(core, worktree, spec, round);
    if (!core.state.decisions.has(round)) checkDeadline(core);
    const decision = decideRound(core, round, settled);
    if (decision === 'repair') continue;
    if (decision === 'ready')
      await polish(
        core,
        worktree,
        spec,
        round,
        core.state.workspace?.baseSha ?? roundStart(core, 0),
        protectedFiles(core),
      );
    if (decision === 'ready' && deliveryPolicy(core).mode === 'unattended' && !core.state.comparisonId) {
      policyDecision(core, {
        key: `complete:${round}`,
        action: 'complete',
        reason: 'All required checks, integrity and independent review passed under the recorded mandate.',
        sha: finalCandidate(core.state)?.sha ?? null,
        specVersion: spec.version,
      });
      if (core.state.recipe.explain.automatic) await explainFinalCandidate(core, spec.version);
      return finish(core, 'accepted', false, null);
    }
    const choice = await askUser(core, round, decision, spec.version);
    if (choice.kind === 'accept') return finish(core, 'accepted', decision === 'escalate', null);
  }
}

/** An automatic explanation is tied to the final candidate after a possible polish pass. */
async function explainFinalCandidate(core: DriverCore, specVersion: number): Promise<void> {
  const candidateSha = finalCandidate(core.state)?.sha;
  if (!candidateSha) throw new Error('There is no verified candidate to explain.');
  if (core.state.explanations.has(candidateSha)) return;
  const digest = createHash('sha256').update(`${core.state.taskId}:${candidateSha}:${specVersion}`).digest('hex');
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  await core.runReview({
    kind: 'explain',
    id,
    at: new Date().toISOString(),
    source: 'cli',
    baseSha: core.state.workspace?.baseSha ?? '',
    candidateSha,
    specVersion,
  });
}

async function ensureRun(core: DriverCore): Promise<void> {
  const here = process.env.ORCA_TERMINAL_HANDLE ?? null;
  const runId = core.state.runId;
  if (runId) {
    const created = core.events.find(event => event.type === 'run.created');
    // An Orca terminal coordinates one Run; a driver restarted in another terminal must rebind it.
    if (created?.type === 'run.created' && here && created.coordinatorHandle !== here)
      await core.repeatUncertain(() => core.orca.useRun(runId));
    return;
  }
  const run = await core.mutate(() => core.orca.createRun(`Grampus: ${core.state.title}`, core.requestId('run')));
  core.record({ type: 'run.created', runId: run.runId, coordinatorHandle: run.coordinatorHandle });
  core.log(`Orca run ${run.runId} created.`);
}

/** Optional acceptance tests written before the build. Their files become protected. */
async function testsFirst(core: DriverCore, worktree: string, spec: SpecVersion): Promise<void> {
  if (core.state.testsFirst) return;
  const inherited = core.state.inheritedTests;
  if (inherited) {
    const head = await headSha(worktree);
    if (head !== inherited.sha) {
      if (head !== core.state.workspace?.baseSha || (await uncommittedPaths(worktree)).length)
        throw new DriverStop('Shared acceptance tests require the clean base commit.');
      const changes = await changedPaths(worktree, head, inherited.sha);
      if (changes.some(change => !['A', 'M'].includes(change.status) || !inherited.files.includes(change.path)))
        throw new DriverStop('The shared tests commit contains changes outside its recorded test files.');
      await git(worktree, ['merge', '--ff-only', '--quiet', inherited.sha]);
    }
    core.record({ type: 'tests.recorded', sha: inherited.sha, files: inherited.files });
    return;
  }
  const assignment = core.state.recipe.testsFirst;
  if (!assignment) return;
  const fromSha = core.state.workspace?.baseSha ?? (await headSha(worktree));
  const settled = await core.runStage({
    key: stageKey('tests', 0),
    stage: 'tests',
    round: 0,
    title: `Acceptance tests: ${core.state.title}`,
    spec: () =>
      testsFirstPrompt({
        specPath: approvedSpecPath(worktree),
        checks: spec.checks,
        reportPath: workerFile(worktree, 'tests:0', 'report.json'),
      }),
    launch: { assignment },
  });
  const sha = await headSha(worktree);
  const changes = await changedPaths(worktree, fromSha, sha);
  const settings = currentSettings();
  const invalid = changes.filter(
    change =>
      !['A', 'M'].includes(change.status) ||
      !matchesAny(change.path, settings.testFilePatterns) ||
      matchesAny(change.path, settings.checkConfigPatterns),
  );
  if (invalid.length)
    throw new DriverStop(
      `Tests first changed non-test files or removed tests: ${invalid.map(c => c.path).join(', ')}. Restore the test-only boundary before resuming.`,
    );
  const added = changes.map(change => change.path);
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
  // Usually the checks already ran at this commit while the spec awaited approval; tests first moves HEAD.
  const before = core.state.specChecks.get(spec.version);
  if (before?.sha === sha) {
    core.record({
      type: 'checks.recorded',
      specVersion: spec.version,
      phase: 'baseline',
      round: 0,
      sha,
      results: before.results,
    });
    core.log('Baseline: the checks run before approval, at the same commit.');
    return;
  }
  core.log('Running baseline checks.');
  const results = await runChecks(worktree, spec.checks, core.store.checksDir('baseline', 0), {
    rerunFailures: false,
    signal: deliverySignal(core),
  });
  checkDeadline(core);
  core.record({ type: 'checks.recorded', specVersion: spec.version, phase: 'baseline', round: 0, sha, results });
  core.log(
    `Baseline: ${results.filter(result => result.passed).length}/${results.length} checks pass before the change.`,
  );
}

/**
 * The commit a round starts from: the baseline for the build, the previous candidate for a repair, or
 * its polish when that was kept.
 */
function roundStart(core: DriverCore, round: number): string {
  const polished = core.state.polish.get(round - 1)?.decided;
  const previous = polished?.kept ? polished.sha : core.state.guard.get(round - 1)?.sha;
  const sha = round === 0 ? core.state.baseline?.sha : previous;
  if (!sha) throw new Error(`Round ${round} has no starting commit.`);
  return sha;
}

function protectedFiles(core: DriverCore): string[] {
  return core.state.testsFirst?.files ?? [];
}

function buildRound(core: DriverCore, worktree: string, spec: SpecVersion, round: number): Promise<Settled> {
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
        request: core.state.request,
        specPath,
        checks: spec.checks,
        protectedPaths,
        round,
        problems: problemsOf(core, round - 1),
      }),
    launch: repairLaunch(core, round),
  });
}

/** Early repair rounds continue the builder's conversation; later ones start fresh with distilled problems. */
function repairLaunch(core: DriverCore, round: number): Launch {
  const recipe = core.state.recipe;
  const assignment = selectedRepairAssignment(core, round);
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

function problemsOf(core: DriverCore, round: number): RepairProblems {
  const report = core.state.reviews.get(round)?.report;
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
    coverage: report ? coverageProblems(report) : [],
    // Every continue so far, not only the one that granted this round: an automatic round after it
    // otherwise never hears what the user asked, and once undid it.
    guidance: core.state.commands.flatMap(command => (command.kind === 'continue' ? [command.guidance] : [])),
  };
}

async function guardRound(core: DriverCore, worktree: string, spec: SpecVersion, round: number): Promise<void> {
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
    core.record({ type: 'guard.recorded', specVersion: spec.version, round, fromSha, sha, guard });
    if (guard.violations.length) core.log(`Guard: ${guard.violations.join('; ')}`);
  }
}

/** Isolated review can overlap checks; both settle before any repair or acceptance can mutate the branch. */
async function verifyAndReview(core: DriverCore, worktree: string, spec: SpecVersion, round: number): Promise<void> {
  await guardRound(core, worktree, spec, round);
  if (!core.state.recipe.delivery) {
    await verify(core, worktree, spec, round);
    await review(core, worktree, round);
    return;
  }
  const results = await Promise.allSettled([verify(core, worktree, spec, round), review(core, worktree, round)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

async function verify(core: DriverCore, worktree: string, spec: SpecVersion, round: number): Promise<void> {
  if (core.state.verify.has(round)) return;
  const sha = core.state.guard.get(round)?.sha ?? (await headSha(worktree));
  const before = await evidenceSnapshot(worktree, sha, spec);
  core.log(`Running checks at ${sha.slice(0, 12)}.`);
  const results = await runChecks(worktree, spec.checks, core.store.checksDir('verify', round), {
    rerunFailures: true,
    signal: deliverySignal(core),
  });
  checkDeadline(core);
  await assertEvidenceUnchanged(worktree, sha, spec, before);
  core.record({ type: 'checks.recorded', specVersion: spec.version, phase: 'verify', round, sha, results });
  core.log(`Checks: ${results.filter(result => result.passed).length}/${results.length} pass.`);
}

async function review(core: DriverCore, worktree: string, round: number): Promise<void> {
  if (!core.state.recipe.review || core.state.decisions.has(round)) return;
  const policy = core.state.recipe.delivery;
  const corrections = policy?.reportRetries ?? 0;
  const investigations = policy?.investigations ?? 0;
  let corrected = 0;
  let investigated = 0;
  let guidance = '';
  for (let attempt = 0; ; attempt++) {
    const recorded = core.events.find(
      event => event.type === 'review.recorded' && event.round === round && (event.attempt ?? 0) === attempt,
    );
    if (!recorded) await reviewOnce(core, worktree, round, attempt, guidance);
    const result = core.state.reviews.get(round);
    const report = result?.report;
    if (result?.error && corrected < corrections) {
      corrected++;
      guidance = `Correct the report at the SAME candidate, without rebuilding. Validation error: ${result.error}. Reassess only if needed to produce honest evidence. Return the exact report schema.`;
      policyDecision(core, {
        key: `review-correction:${round}:${attempt}`,
        action: 'recover',
        reason: guidance,
        sha: result.sha,
        specVersion: result.specVersion,
      });
      continue;
    }
    const uncertain =
      report &&
      (report.verdict === 'unknown' ||
        (coverageProblems(report).length && !actionableCoverage(result)) ||
        unresolvedConcerns(report).length);
    if (uncertain && investigated < investigations) {
      investigated++;
      guidance = `Investigate these unresolved claims with focused executable reproductions. Do not dismiss a concrete correctness concern as speculative without testing it. Resolve or retain it as unknown. Do not change production code. Prior report: ${JSON.stringify(report)}`;
      policyDecision(core, {
        key: `review-investigation:${round}:${attempt}`,
        action: 'investigate',
        reason: 'Gather evidence before requesting a user decision.',
        sha: result.sha,
        specVersion: result.specVersion,
      });
      continue;
    }
    return;
  }
}

async function reviewOnce(
  core: DriverCore,
  worktree: string,
  round: number,
  attempt: number,
  guidance: string,
): Promise<void> {
  const assignment = core.state.recipe.review;
  if (!assignment) return;
  const key = attempt ? `review:${round}:attempt:${attempt}` : stageKey('review', round);
  const reportPath = workerFile(worktree, key, 'report.json');
  const guard = core.state.guard.get(round);
  const candidate =
    core.state.verify.get(round) ?? (guard ? { sha: guard.sha, specVersion: guard.specVersion, results: [] } : null);
  if (!candidate || !guard) throw new Error(`Round ${round} has no verified candidate to review.`);
  const spec = core.state.specs.find(item => item.version === candidate.specVersion);
  if (!spec) throw new DriverStop('The checked specification is unavailable.');
  const before = await evidenceSnapshot(worktree, candidate.sha, spec);
  const workspace = await reviewWorkspace(core, worktree, candidate.sha, spec);
  const settled = await core.runStage({
    key,
    stage: 'review',
    round,
    title: `Review ${round}: ${core.state.title}`,
    spec: () =>
      reviewPrompt({
        request: core.state.request,
        guidance: [
          guidance,
          ...(candidate.results.length
            ? []
            : [
                'Driver checks are running concurrently. Do not claim they passed; establish behavioural coverage independently. Readiness requires the driver to record every required check successfully at this exact commit.',
              ]),
          ...(workspace !== worktree
            ? [
                `ISOLATED REVIEW WORKSPACE: ${workspace}. Change directory there before running commands. Read the original request and form your own boundary-risk assessment before reading the builder's tests. Reproduce high-risk state transitions with executable probes. You may create new test fixtures here, but do not change production files or the original candidate. Include complete runnable probe source and commands in the report; Grampus executes them independently. A passing suite alone does not disprove an untested race.`,
              ]
            : []),
          ...core.state.commands.flatMap(command => (command.kind === 'continue' ? [command.guidance] : [])),
          `Reassess prior review probes and report their committed regressions: ${JSON.stringify(core.state.reviews.get(round - 1)?.report?.probes ?? [])}`,
        ],
        specPath: approvedSpecPath(worktree),
        baseSha: core.state.workspace?.baseSha ?? roundStart(core, 0),
        roundFromSha: guard.fromSha,
        acceptanceTests: protectedFiles(core),
        testBaseline:
          core.state.testBaseline?.assessments.map(item => `${item.name}: ${item.outcome}. ${item.reason}`) ?? [],
        sha: candidate.sha,
        reportPath,
        results: candidate.results,
        modifiedTests: sinceBuild(core, round, result => result.modifiedTests),
        modifiedCheckConfig: sinceBuild(core, round, result => result.modifiedCheckConfig ?? []),
        previousFindings: round > 0 ? (core.state.reviews.get(round - 1)?.blocking ?? []) : [],
      }),
    launch: { assignment },
  });
  await assertEvidenceUnchanged(worktree, candidate.sha, spec, before);
  try {
    if (settled.outcome === 'failed') throw new Error(`The reviewer reported failure: ${settled.body}`);
    const text = readWorkerFile(reportPath);
    if (text === null) throw new Error(`No review report was written at ${reportPath}.`);
    const report = parseReviewReport(text);
    validateCoverage(
      report,
      spec.acceptance.map(item => item.id),
    );
    await retainReviewProbes(
      worktree,
      candidate.sha,
      report,
      [...core.state.reviews.values()].reverse().flatMap(item => item.report ?? []),
    );
    await executeReviewProbes(
      core,
      workspace,
      { sha: candidate.sha, specVersion: spec.version, round, attempt },
      report,
    );
    await assertEvidenceUnchanged(worktree, candidate.sha, spec, before);
    const outcome = judgeCodeReview(report);
    keepEvidence(reportPath, join(core.store.dir, 'reviews', `round-${round}-attempt-${attempt}.json`));
    core.record({
      type: 'review.recorded',
      attempt,
      specVersion: candidate.specVersion,
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
      attempt,
      specVersion: candidate.specVersion,
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
  if (recorded) {
    const checked = core.state.verify.get(round);
    if (checked?.sha !== recorded.sha || checked.specVersion !== recorded.specVersion)
      throw new DriverStop('The recorded round decision does not match its check evidence.');
    return recorded.decision;
  }
  const { problems, coverage } = roundProblems(core, round);
  const stoppers = roundStoppers(core, round, settled);
  const budget = repairBudget(core, round, coverage);
  const decision = stoppers.length
    ? 'escalate'
    : !problems.length
      ? 'ready'
      : budget.used < budget.allowed
        ? 'repair'
        : 'escalate';
  if (!stoppers.length && problems.length && decision === 'escalate')
    problems.push(
      `${coverage ? 'coverage' : 'ordinary'} repair allowance exhausted (${budget.used}/${budget.allowed})`,
    );
  const checked = core.state.verify.get(round);
  if (!checked) throw new DriverStop('No check evidence for this round.');
  core.record({
    type: 'round.decided',
    specVersion: checked.specVersion,
    sha: checked.sha,
    round,
    decision,
    reasons: [...stoppers, ...problems],
  });
  core.log(
    `Round ${round}: ${decision}${problems.length + stoppers.length ? ` (${[...stoppers, ...problems].join('; ')})` : ''}.`,
  );
  return decision;
}

/** Keep coverage failures in the decision evidence even when they qualify for automatic repair. */
function roundProblems(core: DriverCore, round: number): { problems: string[]; coverage: boolean } {
  const problems: string[] = [...(core.state.guard.get(round)?.guard.violations ?? [])];
  for (const result of core.state.verify.get(round)?.results ?? [])
    if (!result.passed) problems.push(`check "${result.name}" failed${result.timedOut ? ' (timed out)' : ''}`);
  const reviewed = core.state.reviews.get(round);
  for (const finding of reviewed?.blocking ?? []) problems.push(`blocking finding: ${finding.title}`);
  const coverage = reviewed?.report ? coverageProblems(reviewed.report) : [];
  problems.push(...coverage);
  return { problems, coverage: coverage.length > 0 };
}

/** Count recorded automatic decisions, so restarts and manual rounds cannot replenish either allowance. */
function repairBudget(core: DriverCore, round: number, coverage: boolean): { used: number; allowed: number } {
  let used = 0;
  for (const [earlier, decision] of core.state.decisions) {
    if (earlier >= round || decision.decision !== 'repair') continue;
    const report = core.state.reviews.get(earlier)?.report;
    const wasCoverage = report ? coverageProblems(report).length > 0 : false;
    if (wasCoverage === coverage) used++;
  }
  return {
    used,
    allowed: coverage ? core.state.recipe.repair.coverageGapRounds : core.state.recipe.repair.maxRounds,
  };
}

/** Missing evidence and uncertain review need a person, rather than another blind repair. */
function roundStoppers(core: DriverCore, round: number, settled: Settled): string[] {
  const reviewed = core.state.reviews.get(round);
  const stoppers: string[] = [];
  if (builderNeedsDecision(core, round, settled)) stoppers.push(`${builderFailed}${settled.body}`);
  if (reviewed?.error) stoppers.push(`review unavailable: ${reviewed.error}`);
  if (core.state.recipe.review && !reviewed?.report) stoppers.push('review unavailable');
  // A concrete failing scenario can drive repair; uncertainty alone cannot justify autonomous edits.
  if (reviewed?.report && coverageProblems(reviewed.report).length && !actionableCoverage(reviewed))
    stoppers.push('coverage assessment has no supported repair or is unknown');
  if (reviewed?.report?.verdict === 'unknown') stoppers.push('review verdict unknown');
  if (reviewed?.report?.verdict === 'changes' && !reviewed.blocking.length)
    stoppers.push('review requests changes without a supported finding');
  if (hasUnresolvedConcerns(core, reviewed))
    stoppers.push('concrete correctness concerns remain unresolved after investigation');
  if (!finalCandidate(core.state)) stoppers.push('candidate evidence does not match the current commit and spec');
  return stoppers;
}

function builderNeedsDecision(core: DriverCore, round: number, settled: Settled): boolean {
  return settled.outcome === 'failed' && (!core.state.recipe.delivery || !roundProblems(core, round).problems.length);
}

function hasUnresolvedConcerns(core: DriverCore, reviewed: ReviewRecord | undefined): boolean {
  return Boolean(core.state.recipe.delivery && reviewed?.report && unresolvedConcerns(reviewed.report).length);
}

/** Unknown evidence cannot authorise edits; a supported failing scenario can. */
function actionableCoverage(review: ReviewRecord): boolean {
  const requestCoverage = review.report?.requestCoverage?.verdict;
  if (review.report?.verdict !== 'unknown' && review.report?.probes?.some(probe => !probe.regressionTest)) return true;
  return (
    review.report?.verdict === 'changes' &&
    (requestCoverage === 'covered' || requestCoverage === 'gaps') &&
    review.blocking.length > 0
  );
}

async function askUser(
  core: DriverCore,
  round: number,
  decision: 'escalate' | 'ready',
  specVersion: number,
): Promise<UserCommand> {
  const made = core.decisionAfter(`${decision}:${round}`, ['accept', 'continue', 'abandon']);
  if (made) return made;
  const sha = finalCandidate(core.state)?.sha.slice(0, 12) ?? 'unknown';
  const reasons = core.state.decisions.get(round)?.reasons ?? [];
  const verdict = core.state.reviews.get(round)?.report?.verdict;
  const candidate = finalCandidate(core.state);
  const worktree = core.state.workspace?.path;
  const spec = core.state.specs.find(item => item.version === specVersion);
  if (!candidate || !worktree || !spec) throw new DriverStop('No current candidate evidence is available.');
  const snapshot = await evidenceSnapshot(worktree, candidate.sha, spec);
  const watch = async () => {
    // Full comparisons temporarily overlay other entries' tests while these drivers wait.
    // Their final acceptance still requires the restored, clean candidate in finish().
    if (!core.state.comparisonId) await assertEvidenceUnchanged(worktree, candidate.sha, spec, snapshot);
    if (core.state.recipe.explain.automatic) await explainFinalCandidate(core, specVersion);
  };
  if (decision === 'ready')
    return core.decide(
      `ready:${round}`,
      `Verified at ${sha}: every check passes${verdict ? `, review ${verdict}` : ', no review'}.${polishNote(core.state, round)}${baselineNote(core)}${testBaselineNote(core)}${checkConfigNote(core, round)} Accept, continue with guidance, or abandon.`,
      ['accept', 'continue', 'abandon'],
      watch,
    );
  return core.decide(
    `escalate:${round}`,
    `Round ${round} needs you at ${sha}: ${reasons.join('; ')}.${testBaselineNote(core)}${checkConfigNote(core, round)} Continue with guidance, accept anyway, or abandon.`,
    ['continue', 'accept', 'abandon'],
    watch,
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
  const head = worktree ? await headSha(worktree).catch(() => null) : null;
  const candidate = finalCandidate(core.state);
  if (
    outcome === 'accepted' &&
    (!candidate || head !== candidate.sha || (worktree && (await uncommittedPaths(worktree)).length))
  )
    throw new DriverStop('The worktree no longer matches the final checked candidate; acceptance stopped.');
  if (outcome === 'accepted' && worktree && candidate) {
    const spec = core.state.specs.find(item => item.version === candidate.specVersion);
    if (!spec) throw new DriverStop('The approved specification is unavailable.');
    await evidenceSnapshot(worktree, candidate.sha, spec);
  }
  const sha = outcome === 'accepted' ? (candidate?.sha ?? null) : head;
  core.record({ type: 'task.finished', outcome, sha, override, reason });
  core.log(`Task ${outcome}${override ? ' with unresolved problems' : ''}${sha ? ` at ${sha.slice(0, 12)}` : ''}.`);
}
