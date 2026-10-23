// The spec phase: a worker writes the spec (asking the user through Orca's `ask`), Grampus runs its checks
// on the base commit, an optional reviewer from the other family comments on the spec with those results,
// and the user approves an exact version or asks for a revision. The spec reaches the user as soon as it
// is written; the check results and the review are added as they land, each with a fresh request. A
// review still running when the user decides is stopped; checks finish after an approval, since they
// become the baseline, and stop after a revision. Revisions continue the spec writer's conversation when
// Orca can reuse it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logExcerpt, runChecks } from '../checks/run-checks.js';
import { specLimits } from '../config/limits.js';
import type { CheckResult, UserCommand } from '../domain/events.js';
import { parseReviewReport, validateCoverage } from '../domain/review.js';
import { headSha } from '../git/git.js';
import { withRepositoryChecks } from '../domain/spec.js';
import { specPrompt, specReviewPrompt } from './prompts.js';
import type { DriverCore, Settled } from './driver-core.js';
import { currentDispatch, stageKey, type SpecVersion } from './state.js';
import { approvedSpecPath, keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';

interface Attempt {
  feedback: string | null;
  rejection: string | null;
}

/** Run the spec phase to an approved spec version. */
export async function approveSpec(core: DriverCore, worktree: string): Promise<SpecVersion> {
  const inherited = core.state.inherited ? core.state.specs[0] : undefined;
  if (inherited) {
    writeFileSync(approvedSpecPath(worktree), readFileSync(inherited.path, 'utf8'));
    return inherited;
  }
  let attempt: Attempt = { feedback: null, rejection: null };
  for (let number = 1; ; number++) {
    const key = stageKey('spec', number);
    const settled = await writeSpec(core, worktree, number, attempt);
    if (settled.outcome === 'failed') {
      const choice = await core.decide(
        `spec-failed:${number}`,
        `The spec writer could not write a spec: ${settled.body}`,
        ['revise', 'abandon'],
      );
      attempt = { feedback: choice.kind === 'revise' ? choice.feedback : null, rejection: null };
      continue;
    }
    const recorded = recordSpec(core, worktree, key);
    if (typeof recorded === 'string') {
      attempt = await afterRejection(core, number, recorded);
      continue;
    }
    const checks = await startSpecChecks(core, worktree, recorded);
    const decision = `approve-spec:${recorded.version}`;
    let choice: UserCommand;
    try {
      choice = await core.decide(decision, approvalDetail(core, recorded, checks), ['approve', 'revise'], async () => {
        if (landSpecChecks(core, recorded, checks))
          core.requestDecision(decision, approvalDetail(core, recorded, checks), ['approve', 'revise']);
        if (core.state.specChecks.has(recorded.version) || checks?.failure)
          await startSpecReview(core, worktree, recorded);
        collectSpecReview(core, worktree, recorded, checks, decision);
      });
    } catch (error) {
      await stopSpecChecks(checks);
      throw error;
    }
    // Approved checks become the baseline, so they finish; a revision's checks are of a spec nobody builds.
    if (choice.kind === 'approve') {
      if (checks && !core.state.specChecks.has(recorded.version)) core.log('Finishing the checks before the build.');
      await checks?.done;
      landSpecChecks(core, recorded, checks);
    } else await stopSpecChecks(checks);
    collectSpecReview(core, worktree, recorded, checks, null);
    if (!core.state.specReviews.has(recorded.version)) {
      const key = stageKey('spec-review', recorded.version);
      const started = core.state.stages.has(key);
      await core.stopStage(key, 'the user decided first');
      core.record({
        type: 'spec_review.recorded',
        specVersion: recorded.version,
        report: null,
        error:
          started || !core.state.recipe.specReview
            ? 'stopped: the user decided before the review finished'
            : 'not started: the user decided before the checks on the original commit finished',
      });
    }
    if (choice.kind === 'approve') {
      await resolveGate(core);
      writeFileSync(approvedSpecPath(worktree), readFileSync(recorded.path, 'utf8'));
      core.log(`Spec version ${recorded.version} approved.`);
      return recorded;
    }
    attempt = { feedback: choice.kind === 'revise' ? choice.feedback : null, rejection: null };
  }
}

function writeSpec(core: DriverCore, worktree: string, number: number, attempt: Attempt): Promise<Settled> {
  const key = stageKey('spec', number);
  const previousKey = stageKey('spec', number - 1);
  const previous = currentDispatch(core.state.stages.get(previousKey));
  const recipe = core.state.recipe;
  const previousSpec = core.state.specs.at(-1)?.path ?? null;
  return core.runStage({
    key,
    stage: 'spec',
    round: number,
    title: number === 1 ? `Spec: ${core.state.title}` : `Spec revision ${number - 1}: ${core.state.title}`,
    spec: () =>
      specPrompt({
        request: core.state.request,
        specPath: workerFile(worktree, key, 'spec.md'),
        previousSpecPath: number === 1 ? null : previousSpec,
        feedback: attempt.feedback,
        rejection: attempt.rejection,
        answered: answeredQuestions(core),
        setup: core.state.setup.configuration?.command?.command ?? null,
        repositoryChecks: core.state.setup.configuration?.verification.checks ?? [],
      }),
    launch: previous ? { reuse: previous, fallback: recipe.spec } : { assignment: recipe.spec },
  });
}

/** Questions spec writers asked and the user answered, with the answers. */
function answeredQuestions(core: DriverCore): { question: string; answer: string }[] {
  return core.state.commands.flatMap(command => {
    if (command.kind !== 'reply') return [];
    const question = core.state.questions.get(command.messageId);
    if (!question?.key?.startsWith('spec:')) return [];
    return [{ question: question.body || question.subject, answer: command.body }];
  });
}

/** Read, validate and keep the spec a settled writer produced. Returns the version, or the rejection reason. */
function recordSpec(core: DriverCore, worktree: string, key: string): SpecVersion | string {
  const existing = core.state.specs.find(spec => spec.key === key);
  if (existing) return existing;
  const rejected = core.state.rejectedSpecs.get(key);
  if (rejected) return rejected;
  const source = workerFile(worktree, key, 'spec.md');
  const text = readWorkerFile(source);
  try {
    if (text === null) throw new Error(`No spec file was written at ${source}.`);
    const spec = withRepositoryChecks(text, core.state.setup.configuration?.verification.checks ?? []);
    const version = core.state.specs.length + 1;
    const path = join(core.store.dir, 'spec', `v${version}.md`);
    keepEvidence(source, path);
    writeFileSync(path, spec.markdown);
    core.record({
      type: 'spec.recorded',
      key,
      version,
      hash: spec.hash,
      path,
      checks: spec.block.checks,
      acceptance: spec.block.acceptance,
      protected: spec.block.protected,
    });
    core.log(`Spec version ${version} recorded: ${spec.block.checks.length} checks.`);
    const recorded = core.state.specs.at(-1);
    if (!recorded) throw new Error('unreachable');
    return recorded;
  } catch (error) {
    const reason = (error as Error).message;
    core.record({ type: 'spec.rejected', key, error: reason });
    core.log(`Spec from ${key} rejected: ${reason}`);
    return reason;
  }
}

async function afterRejection(core: DriverCore, number: number, reason: string): Promise<Attempt> {
  const recentRejections = countTrailingRejections(core, number);
  if (recentRejections <= specLimits.automaticCorrections) return { feedback: null, rejection: reason };
  const choice = await core.decide(`spec-invalid:${number}`, `The spec file is still unusable: ${reason}`, [
    'revise',
    'abandon',
  ]);
  return { feedback: choice.kind === 'revise' ? choice.feedback : null, rejection: reason };
}

/** Consecutive rejected spec attempts ending at `number`. */
function countTrailingRejections(core: DriverCore, number: number): number {
  let count = 0;
  for (let index = number; index >= 1 && core.state.rejectedSpecs.has(stageKey('spec', index)); index--) count++;
  return count;
}

/** A spec version's checks, running at the base commit while the user decides. */
interface SpecChecks {
  sha: string;
  results: CheckResult[] | null;
  /** Why the checks could not run at all; nothing is recorded then. */
  failure: string | null;
  done: Promise<void>;
  controller: AbortController;
}

/**
 * Start the spec's checks at the base commit unless they are recorded. A check that already fails here for
 * a reason other than the missing behaviour (no tests ran, a missing tool) can never show the behaviour,
 * and the user and the spec reviewer should see that before anyone builds.
 */
async function startSpecChecks(core: DriverCore, worktree: string, spec: SpecVersion): Promise<SpecChecks | null> {
  if (core.state.specChecks.has(spec.version)) return null;
  const sha = await headSha(worktree);
  const controller = new AbortController();
  core.log(`Running the checks of spec version ${spec.version} at ${sha.slice(0, 12)}.`);
  const checks: SpecChecks = { sha, results: null, failure: null, done: Promise.resolve(), controller };
  checks.done = runChecks(worktree, spec.checks, core.store.checksDir('spec', spec.version), {
    rerunFailures: false,
    signal: controller.signal,
  }).then(
    results => {
      checks.results = results;
    },
    (error: unknown) => {
      checks.failure = (error as Error).message;
      core.log(`The checks of spec version ${spec.version} could not run: ${checks.failure}`);
    },
  );
  return checks;
}

/** Record finished spec checks. Returns whether this call recorded them. */
function landSpecChecks(core: DriverCore, spec: SpecVersion, checks: SpecChecks | null): boolean {
  if (!checks?.results || checks.controller.signal.aborted || core.state.specChecks.has(spec.version)) return false;
  core.record({
    type: 'checks.recorded',
    specVersion: spec.version,
    phase: 'spec',
    round: spec.version,
    sha: checks.sha,
    results: checks.results,
  });
  const passed = checks.results.filter(result => result.passed).length;
  core.log(`Spec version ${spec.version}: ${passed}/${checks.results.length} checks pass before the change.`);
  return true;
}

async function stopSpecChecks(checks: SpecChecks | null): Promise<void> {
  checks?.controller.abort();
  await checks?.done;
}

async function startSpecReview(core: DriverCore, worktree: string, spec: SpecVersion): Promise<void> {
  const assignment = core.state.recipe.specReview;
  const key = stageKey('spec-review', spec.version);
  const record = core.state.stages.get(key);
  // Runs on every pump while the user decides; only a review that never got a worker needs launching.
  if (!assignment || core.state.specReviews.has(spec.version) || currentDispatch(record) || record?.startFailure)
    return;
  const reportPath = workerFile(worktree, key, 'report.json');
  const before = core.state.specChecks.get(spec.version);
  await core.launchStage({
    key,
    stage: 'spec-review',
    round: spec.version,
    title: `Spec review v${spec.version}: ${core.state.title}`,
    spec: () =>
      specReviewPrompt({
        request: core.state.request,
        specPath: spec.path,
        reportPath,
        checksBefore: before
          ? before.results.map(result => ({ result, excerpt: result.passed ? null : logExcerpt(result.logPath) }))
          : null,
      }),
    launch: { assignment },
  });
}

/**
 * Record the spec review once its worker has ended. While the decision is pending (`decision` set), the
 * request is raised again with the review in it, whatever it found: a user waiting for the review must
 * hear that it landed, and the earlier request still says it is running.
 */
function collectSpecReview(
  core: DriverCore,
  worktree: string,
  spec: SpecVersion,
  checks: SpecChecks | null,
  decision: string | null,
): void {
  const key = stageKey('spec-review', spec.version);
  const record = core.state.stages.get(key);
  const dispatch = currentDispatch(record);
  if (!record || core.state.specReviews.has(spec.version)) return;
  if (!record.startFailure && !dispatch?.settled && !dispatch?.exited) return;
  const reportPath = workerFile(worktree, key, 'report.json');
  recordSpecReview(core, spec, reportPath, dispatch?.settled ?? null, record.startFailure?.error ?? null);
  if (decision) core.requestDecision(decision, approvalDetail(core, spec, checks), ['approve', 'revise']);
}

function recordSpecReview(
  core: DriverCore,
  spec: SpecVersion,
  reportPath: string,
  settled: { outcome: 'succeeded' | 'failed'; body: string } | null,
  startError: string | null,
): void {
  const text = readWorkerFile(reportPath);
  try {
    if (startError) throw new Error(`The spec reviewer could not start: ${startError}`);
    if (!settled) throw new Error('The spec reviewer ended without reporting.');
    if (settled.outcome === 'failed') throw new Error(`The spec reviewer reported failure: ${settled.body}`);
    if (text === null) throw new Error(`No report was written at ${reportPath}.`);
    const report = parseReviewReport(text);
    validateCoverage(report);
    keepEvidence(reportPath, join(core.store.dir, 'spec', `v${spec.version}-review.json`));
    core.record({ type: 'spec_review.recorded', specVersion: spec.version, report, error: null });
  } catch (error) {
    core.record({
      type: 'spec_review.recorded',
      specVersion: spec.version,
      report: null,
      error: (error as Error).message,
    });
  }
}

function approvalDetail(core: DriverCore, spec: SpecVersion, checks: SpecChecks | null): string {
  const review = core.state.specReviews.get(spec.version);
  const blocking = review?.report?.findings.filter(finding => finding.severity === 'blocking').length ?? 0;
  const reviewText = review
    ? review.report
      ? `spec review: ${review.report.verdict}, ${blocking} blocking of ${review.report.findings.length} findings`
      : `spec review unavailable: ${review.error ?? 'unknown'}`
    : !core.state.recipe.specReview
      ? 'no spec review'
      : core.state.stages.has(stageKey('spec-review', spec.version))
        ? 'spec review still running (approve now or wait for its findings)'
        : 'spec review starts when the checks finish';
  const coverage = review?.report?.requestCoverage;
  return `Approve spec version ${spec.version} (${spec.path}); ${checksText(core, spec, checks)}; ${reviewText}.${coverage ? ` Original request: ${coverage.verdict}. ${coverage.rationale}` : ''}`;
}

function checksText(core: DriverCore, spec: SpecVersion, checks: SpecChecks | null): string {
  const recorded = core.state.specChecks.get(spec.version);
  if (!recorded)
    return checks?.failure
      ? `the checks could not run on the original commit: ${checks.failure}`
      : 'checks still running on the original commit';
  const failed = recorded.results.filter(result => !result.passed);
  const passed = recorded.results.length - failed.length;
  if (!failed.length) return `all ${passed} checks already pass on the original commit`;
  const named = failed.map(result => `"${result.name}" (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`})`);
  return `on the original commit ${passed} of ${recorded.results.length} checks pass, failing: ${named.join(', ')}; a check should fail there only because the behaviour is missing`;
}

/** Create the approval gate once, so the decision is visible in Orca too. */
export async function ensureGate(core: DriverCore): Promise<void> {
  if (core.state.gate) return;
  const orcaTaskId = await core.mutate(() =>
    core.orca.createTask(
      {
        runId: core.runId(),
        title: `Approve spec: ${core.state.title}`,
        spec: 'Decision gate for the spec. Not dispatched.',
      },
      core.requestId('gate:task'),
    ),
  );
  const gateId = await core.mutate(() =>
    core.orca.createGate(
      { taskId: orcaTaskId, question: 'Approve the spec?', options: ['approve', 'revise'] },
      core.requestId('gate'),
    ),
  );
  core.record({ type: 'gate.created', gateId, orcaTaskId });
}

async function resolveGate(core: DriverCore): Promise<void> {
  const gate = core.state.gate;
  if (!gate || gate.resolution) return;
  await core.mutate(() => core.orca.resolveGate(gate.gateId, 'approve', core.requestId('gate:resolve')));
  core.record({ type: 'gate.resolved', gateId: gate.gateId, resolution: 'approve' });
}
