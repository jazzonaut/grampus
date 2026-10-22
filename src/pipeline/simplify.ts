// The optional simplify pass. Agents tend to overbuild, and a reviewer told to block only incorrect code
// lets bloat through, so after a ready round one worker may make the change smaller without changing
// behaviour. The pass is kept only when the guard, the checks and a review of its own diff all hold;
// otherwise the worktree goes back to the verified commit. It never escalates and never repairs: the
// verified commit is already good, so a doubtful simplification costs only itself.
import { join } from 'node:path';
import { runChecks } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import type { DiffSize, GuardResult, ReviewResult } from '../domain/events.js';
import type { Assignment } from '../domain/recipe.js';
import { judgeCodeReview, parseReviewReport } from '../domain/review.js';
import { diffSize, headSha, resetWorktree } from '../git/git.js';
import type { DriverCore, Settled } from './driver-core.js';
import { inspectCandidate } from './guard.js';
import { simplifyPrompt, simplifyReviewPrompt } from './prompts.js';
import { stageKey, type SimplifyRecord, type SpecVersion, type TaskState } from './state.js';
import { approvedSpecPath, keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';

/**
 * Run the recipe's simplify pass on a ready round, once. `baseSha` is where the change starts and
 * `protectedFiles` are the exact paths the builder may not touch.
 */
export async function simplify(
  core: DriverCore,
  worktree: string,
  spec: SpecVersion,
  round: number,
  baseSha: string,
  protectedFiles: readonly string[],
): Promise<void> {
  const assignment = core.state.recipe.simplify;
  if (!assignment) return;
  const fromSha = core.state.verify.get(round)?.sha;
  if (!fromSha) throw new Error(`Round ${round} has no verified commit to simplify.`);
  if (!core.state.simplify.get(round)?.decided)
    await runPass(core, { worktree, spec, round, baseSha, fromSha, protectedFiles }, assignment);
  // Recorded first, so a driver that stopped before the reset finishes it here.
  const decided = core.state.simplify.get(round)?.decided;
  if (decided && !decided.kept && (await headSha(worktree)) !== fromSha) await resetWorktree(worktree, fromSha);
}

interface Pass {
  worktree: string;
  spec: SpecVersion;
  round: number;
  baseSha: string;
  /** The ready round's verified commit. */
  fromSha: string;
  protectedFiles: readonly string[];
}

/** Simplify, check and review, then record whether the pass is kept. Each step resumes from the log. */
async function runPass(core: DriverCore, pass: Pass, assignment: Assignment): Promise<void> {
  const { worktree, spec, round, baseSha, fromSha } = pass;
  const reviewer = core.state.recipe.review;
  const worker = await core.runOptionalStage({
    key: stageKey('simplify', round),
    stage: 'simplify',
    round,
    title: `Simplify ${round}: ${core.state.title}`,
    spec: () =>
      simplifyPrompt({
        specPath: approvedSpecPath(worktree),
        baseSha,
        sha: fromSha,
        checks: spec.checks,
        protectedPaths: [...spec.protected, ...pass.protectedFiles],
        reviewed: Boolean(reviewer),
      }),
    launch: { assignment },
  });
  const reasons = workerProblems(worker);
  if (!reasons.length && !core.state.simplify.get(round)?.checked) await check(core, pass);
  const checked = core.state.simplify.get(round)?.checked;
  if (!reasons.length && checked) reasons.push(...checkProblems(core.state, checked));
  const sha = checked?.sha ?? (await headSha(worktree));
  const review = !reasons.length && reviewer ? await reviewPass(core, pass, sha) : null;
  if (review) reasons.push(...reviewProblems(review));
  const kept = reasons.length === 0;
  const before = await diffSize(worktree, baseSha, fromSha);
  const after = kept ? await diffSize(worktree, baseSha, sha) : before;
  core.record({ type: 'simplify.decided', round, fromSha, sha, kept, reasons, review, before, after });
  core.log(`Simplify ${round}: ${kept ? 'kept' : `discarded (${reasons.join('; ')})`}.`);
}

function workerProblems(worker: Settled | { error: string }): string[] {
  if ('error' in worker) return [`the simplifier ${worker.error}`];
  return worker.outcome === 'failed' ? [`the simplifier reported failure: ${worker.body}`] : [];
}

/** Guard the simplified commit and, when the guard passes, run the checks at it. */
async function check(core: DriverCore, { worktree, spec, round, fromSha, protectedFiles }: Pass): Promise<void> {
  const sha = await headSha(worktree);
  const guard = await inspectCandidate({
    cwd: worktree,
    fromSha,
    sha,
    protectedGlobs: spec.protected,
    protectedFiles,
    testPatterns: currentSettings().testFilePatterns,
    checkConfigPatterns: currentSettings().checkConfigPatterns,
    checkCommands: spec.checks.map(command => command.command),
  });
  const guarded = guardProblems(core.state, guard);
  if (guarded.length) core.log(`Simplify ${round}: ${guarded.join('; ')}`);
  else core.log(`Running checks at the simplified commit ${sha.slice(0, 12)}.`);
  const results = guarded.length
    ? []
    : await runChecks(worktree, spec.checks, core.store.checksDir('simplify', round), { rerunFailures: true });
  core.record({ type: 'simplify.checked', round, fromSha, sha, guard, results });
}

/** Why a guarded and checked simplification cannot be kept. */
function checkProblems(state: TaskState, checked: NonNullable<SimplifyRecord['checked']>): string[] {
  const reasons = guardProblems(state, checked.guard);
  for (const result of checked.results)
    if (!result.passed) reasons.push(`check "${result.name}" failed${result.timedOut ? ' (timed out)' : ''}`);
  return reasons;
}

function guardProblems(state: TaskState, guard: GuardResult): string[] {
  if (guard.commits === 0 && guard.clean) return ['the simplifier changed nothing'];
  const reasons = [...guard.violations];
  if (guard.modifiedCheckConfig?.length)
    reasons.push(`check configuration changed: ${guard.modifiedCheckConfig.join(', ')}`);
  // Only a reviewer can tell a test that follows the simplified code from a weakened one.
  if (guard.modifiedTests.length && !state.recipe.review)
    reasons.push(`tests changed with no review to confirm they were only adapted: ${guard.modifiedTests.join(', ')}`);
  return reasons;
}

async function reviewPass(core: DriverCore, { worktree, round, fromSha }: Pass, sha: string): Promise<ReviewResult> {
  const assignment = core.state.recipe.review;
  if (!assignment) throw new Error('The recipe has no review.');
  const key = stageKey('simplify-review', round);
  const reportPath = workerFile(worktree, key, 'report.json');
  const checked = core.state.simplify.get(round)?.checked;
  const settled = await core.runOptionalStage({
    key,
    stage: 'simplify-review',
    round,
    title: `Simplify review ${round}: ${core.state.title}`,
    spec: () =>
      simplifyReviewPrompt({
        specPath: approvedSpecPath(worktree),
        fromSha,
        sha,
        reportPath,
        results: checked?.results ?? [],
        modifiedTests: checked?.guard.modifiedTests ?? [],
      }),
    launch: { assignment },
  });
  try {
    if ('error' in settled) throw new Error(`The reviewer ${settled.error}`);
    if (settled.outcome === 'failed') throw new Error(`The reviewer reported failure: ${settled.body}`);
    const text = readWorkerFile(reportPath);
    if (text === null) throw new Error(`No review report was written at ${reportPath}.`);
    const outcome = judgeCodeReview(parseReviewReport(text));
    keepEvidence(reportPath, join(core.store.dir, 'reviews', `simplify-${round}.json`));
    return { ...outcome, error: null };
  } catch (error) {
    return { report: null, blocking: [], downgraded: [], error: (error as Error).message };
  }
}

/** Anything short of a clean approval discards the pass: the verified commit is the safe fallback. */
function reviewProblems(review: ReviewResult): string[] {
  if (!review.report) return [`review unavailable: ${review.error ?? 'unknown'}`];
  const reasons = review.blocking.map(finding => `blocking finding: ${finding.title}`);
  if (review.report.verdict !== 'approve') reasons.push(`review verdict ${review.report.verdict}`);
  return reasons;
}

/** One sentence on a ready round's simplify pass for the accept prompt; empty when there was none. */
export function simplifyNote(state: TaskState, round: number): string {
  const decided = state.simplify.get(round)?.decided;
  if (!decided) return '';
  if (!decided.kept) return ` Simplification discarded: ${decided.reasons.join('; ')}.`;
  return ` Simplified at ${decided.sha.slice(0, 12)}: ${sizeText(decided.before)} became ${sizeText(decided.after)}.`;
}

function sizeText(size: DiffSize): string {
  return `${size.files} files, +${size.added} -${size.deleted}`;
}
