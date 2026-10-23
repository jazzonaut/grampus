// The optional maintenance pass. A worker proposes concrete improvements after a ready round;
// independent review must approve both safety and benefit. Doubtful edits restore the verified commit.
import { join } from 'node:path';
import { runChecks } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import type { DiffSize, GuardResult, ReviewResult } from '../domain/events.js';
import type { Assignment } from '../domain/recipe.js';
import { judgeCodeReview, parseReviewReport } from '../domain/review.js';
import { diffSize, headSha, resetWorktree, uncommittedPaths } from '../git/git.js';
import type { DriverCore, Settled } from './driver-core.js';
import { inspectCandidate } from './guard.js';
import { polishPrompt, polishReviewPrompt } from './prompts.js';
import { stageKey, type PolishRecord, type SpecVersion, type TaskState } from './state.js';
import {
  parsePolishReport,
  polishReviewSchema,
  type PolishReport,
  type MaintenanceAssessment,
} from '../domain/polish.js';
import { reviewLimits, polishLimits } from '../config/limits.js';
import { changedPaths } from '../git/git.js';
import { approvedSpecPath, keepEvidence, readWorkerFile, privateWorkerFile } from './workspace-files.js';
import { assertEvidenceUnchanged, evidenceSnapshot } from './evidence.js';

/**
 * Run the recipe's polish pass on a ready round, once. `baseSha` is where the change starts and
 * `protectedFiles` are the exact paths the builder may not touch.
 */
export async function polish(
  core: DriverCore,
  worktree: string,
  spec: SpecVersion,
  round: number,
  baseSha: string,
  protectedFiles: readonly string[],
): Promise<void> {
  const assignment = core.state.recipe.polish;
  if (!assignment) return;
  const fromSha = core.state.verify.get(round)?.sha;
  if (!fromSha) throw new Error(`Round ${round} has no verified commit to polish.`);
  if (!core.state.polish.get(round)?.decided)
    await runPass(core, { worktree, spec, round, baseSha, fromSha, protectedFiles }, assignment);
  // Recorded first, so a driver that stopped before the reset finishes it here.
  const decided = core.state.polish.get(round)?.decided;
  if (decided?.outcome === 'discarded' && !core.state.polish.get(round)?.restored) {
    if ((await headSha(worktree)) !== fromSha || (await uncommittedPaths(worktree)).length)
      await resetWorktree(worktree, fromSha);
    // Once restored, replaying this round must never reset a later round's work.
    core.record({ type: 'polish.restored', round, sha: fromSha });
  }
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

/** Polish, check and review, then record whether the pass is kept. Each step resumes from the log. */
async function runPass(core: DriverCore, pass: Pass, assignment: Assignment): Promise<void> {
  const { worktree, spec, round, baseSha, fromSha } = pass;
  const reviewer = core.state.recipe.review;
  const reportPath = await privateWorkerFile(worktree, stageKey('polish', round), 'report.json');
  const worker = await core.runOptionalStage({
    key: stageKey('polish', round),
    stage: 'polish',
    round,
    title: `Polish ${round}: ${core.state.title}`,
    spec: () =>
      polishPrompt({
        specPath: approvedSpecPath(worktree),
        baseSha,
        sha: fromSha,
        checks: spec.checks,
        protectedPaths: [...spec.protected, ...pass.protectedFiles],
        reviewed: Boolean(reviewer),
        reportPath,
      }),
    launch: { assignment },
  });
  const reasons = workerProblems(worker);
  let report: PolishReport | null = null;
  try {
    report = parsePolishReport(readWorkerFile(reportPath) ?? '');
    keepEvidence(reportPath, join(core.store.dir, 'reviews', `polish-worker-${round}.json`));
  } catch (error) {
    reasons.push(`polish report unavailable: ${(error as Error).message}`);
  }
  if (!reasons.length && !core.state.polish.get(round)?.checked) await check(core, pass);
  const checked = core.state.polish.get(round)?.checked;
  const noop = isNoop(reasons, checked, fromSha, report);
  const sha = checked?.sha ?? (await headSha(worktree));
  const { review, maintenance } = await assessPass(core, pass, sha, noop, report, reasons);
  const kept = !noop && reasons.length === 0;
  const before = await diffSize(worktree, baseSha, fromSha);
  const after = kept ? await diffSize(worktree, baseSha, sha) : before;
  core.record({
    type: 'polish.decided',
    specVersion: spec.version,
    round,
    fromSha,
    sha,
    kept,
    outcome: noop ? 'noop' : kept ? 'kept' : 'discarded',
    report,
    maintenance,
    reasons,
    review,
    before,
    after,
  });
  core.log(`Polish ${round}: ${noop ? 'no worthwhile change' : kept ? 'kept' : `discarded (${reasons.join('; ')})`}.`);
}

/** No-op is successful only with a clean original commit and no claimed edits. */
function isNoop(
  reasons: readonly string[],
  checked: PolishRecord['checked'] | undefined,
  fromSha: string,
  report: PolishReport | null,
): boolean {
  return !reasons.length && checked?.sha === fromSha && checked.guard.clean && report?.improvements.length === 0;
}

async function assessPass(
  core: DriverCore,
  pass: Pass,
  sha: string,
  noop: boolean,
  report: PolishReport | null,
  reasons: string[],
) {
  const empty = { review: null, maintenance: null };
  if (reasons.length || noop) return empty;
  const checked = core.state.polish.get(pass.round)?.checked;
  if (!checked) {
    reasons.push('polish check evidence unavailable');
    return empty;
  }
  reasons.push(...checkProblems(core.state, checked));
  if (reasons.length) return empty;
  reasons.push(...(await reportProblems(pass, sha, report)));
  if (!core.state.recipe.review) reasons.push('polish needs an independent review');
  if (reasons.length) return empty;
  const reviewed = await reviewPass(core, pass, sha);
  reasons.push(...reviewProblems(reviewed.review));
  if (reviewed.maintenance?.verdict !== 'worth-keeping')
    reasons.push(`maintenance benefit: ${reviewed.maintenance?.verdict ?? 'unknown'}`);
  return reviewed;
}

/** Every edited file needs a claimed benefit; adjacent edits need a specific explanation. */
async function reportProblems(pass: Pass, sha: string, report: PolishReport | null): Promise<string[]> {
  const original = new Set((await changedPaths(pass.worktree, pass.baseSha, pass.fromSha)).map(c => c.path));
  const edited = await changedPaths(pass.worktree, pass.fromSha, sha);
  if (edited.filter(change => !original.has(change.path)).length > polishLimits.adjacentFiles)
    return [`polish exceeded the ${polishLimits.adjacentFiles} adjacent-file limit`];
  if (!edited.length || !report?.improvements.length) return ['no concrete maintenance improvement recorded'];
  return edited.flatMap(change => {
    const claim = report?.improvements.find(item => item.files.includes(change.path));
    if (!claim) return [`no maintenance benefit recorded for ${change.path}`];
    return !original.has(change.path) && !claim.adjacentReason ? [`unexplained adjacent edit: ${change.path}`] : [];
  });
}

function workerProblems(worker: Settled | { error: string }): string[] {
  if ('error' in worker) return [`the polisher ${worker.error}`];
  return worker.outcome === 'failed' ? [`the polisher reported failure: ${worker.body}`] : [];
}

/** Guard the polished commit and, when the guard passes, run the checks at it. */
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
  const before = await evidenceSnapshot(worktree, sha, spec);
  if (guarded.length) core.log(`Polish ${round}: ${guarded.join('; ')}`);
  else core.log(`Running checks at the polished commit ${sha.slice(0, 12)}.`);
  const results = guarded.length
    ? []
    : await runChecks(worktree, spec.checks, core.store.checksDir('polish', round), { rerunFailures: true });
  await assertEvidenceUnchanged(worktree, sha, spec, before);
  core.record({ type: 'polish.checked', specVersion: spec.version, round, fromSha, sha, guard, results });
}

/** Why a guarded and checked polish cannot be kept. */
function checkProblems(state: TaskState, checked: NonNullable<PolishRecord['checked']>): string[] {
  const reasons = guardProblems(state, checked.guard);
  for (const result of checked.results)
    if (!result.passed) reasons.push(`check "${result.name}" failed${result.timedOut ? ' (timed out)' : ''}`);
  return reasons;
}

function guardProblems(state: TaskState, guard: GuardResult): string[] {
  if (guard.commits === 0 && guard.clean) return ['the polisher changed nothing'];
  const reasons = [...guard.violations];
  if (guard.modifiedCheckConfig?.length)
    reasons.push(`check configuration changed: ${guard.modifiedCheckConfig.join(', ')}`);
  // Only a reviewer can tell a test that follows the polished code from a weakened one.
  if (guard.modifiedTests.length && !state.recipe.review)
    reasons.push(`tests changed with no review to confirm they were only adapted: ${guard.modifiedTests.join(', ')}`);
  return reasons;
}

async function reviewPass(
  core: DriverCore,
  { worktree, round, fromSha, spec }: Pass,
  sha: string,
): Promise<{ review: ReviewResult; maintenance: MaintenanceAssessment | null }> {
  const assignment = core.state.recipe.review;
  if (!assignment) throw new Error('The recipe has no review.');
  const key = stageKey('polish-review', round);
  const reportPath = await privateWorkerFile(worktree, key, 'report.json');
  const polishReportPath = await privateWorkerFile(worktree, stageKey('polish', round), 'report.json');
  const checked = core.state.polish.get(round)?.checked;
  const before = await evidenceSnapshot(worktree, sha, spec);
  const settled = await core.runOptionalStage({
    key,
    stage: 'polish-review',
    round,
    title: `Polish review ${round}: ${core.state.title}`,
    spec: () =>
      polishReviewPrompt({
        specPath: approvedSpecPath(worktree),
        fromSha,
        sha,
        reportPath,
        results: checked?.results ?? [],
        modifiedTests: checked?.guard.modifiedTests ?? [],
        polishReportPath,
      }),
    launch: { assignment },
  });
  await assertEvidenceUnchanged(worktree, sha, spec, before);
  try {
    if ('error' in settled) throw new Error(`The reviewer ${settled.error}`);
    if (settled.outcome === 'failed') throw new Error(`The reviewer reported failure: ${settled.body}`);
    const text = readWorkerFile(reportPath);
    if (text === null) throw new Error(`No review report was written at ${reportPath}.`);
    if (Buffer.byteLength(text) > reviewLimits.bytes) throw new Error('Polish review exceeds the report limit.');
    const { maintenance, ...report } = polishReviewSchema.parse(JSON.parse(text));
    const outcome = judgeCodeReview(parseReviewReport(JSON.stringify(report)));
    keepEvidence(reportPath, join(core.store.dir, 'reviews', `polish-${round}.json`));
    return { review: { ...outcome, error: null }, maintenance };
  } catch (error) {
    return {
      review: { report: null, blocking: [], downgraded: [], error: (error as Error).message },
      maintenance: null,
    };
  }
}

/** Anything short of a clean approval discards the pass: the verified commit is the safe fallback. */
function reviewProblems(review: ReviewResult): string[] {
  if (!review.report) return [`review unavailable: ${review.error ?? 'unknown'}`];
  const reasons = review.blocking.map(finding => `blocking finding: ${finding.title}`);
  if (review.report.verdict !== 'approve') reasons.push(`review verdict ${review.report.verdict}`);
  return reasons;
}

/** One sentence on a ready round's polish pass for the accept prompt; empty when there was none. */
export function polishNote(state: TaskState, round: number): string {
  const decided = state.polish.get(round)?.decided;
  if (!decided) return '';
  if (decided.outcome === 'noop') return ` Polish: no worthwhile change found. ${decided.report?.summary ?? ''}`;
  if (!decided.kept) return ` Polish discarded: ${decided.reasons.join('; ')}.`;
  return ` Polished at ${decided.sha.slice(0, 12)}: ${decided.report?.improvements.map(item => item.benefit).join('; ')}. ${sizeText(decided.before)} became ${sizeText(decided.after)}.`;
}

function sizeText(size: DiffSize): string {
  return `${size.files} files, +${size.added} -${size.deleted}`;
}
