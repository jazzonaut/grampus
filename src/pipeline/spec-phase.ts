// The spec phase: a worker writes the spec (asking the user through Orca's `ask`), an
// optional reviewer from the other family comments on it, and the user approves an exact version or asks
// for a revision. The spec reaches the user as soon as it is written; its review runs alongside and is
// added when it lands, with a second request only when it finds something blocking. A review still
// running when the user decides is stopped. Revisions continue the spec writer's conversation when Orca can reuse it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { specLimits } from '../config/limits.js';
import { parseReviewReport } from '../domain/review.js';
import { parseSpec } from '../domain/spec.js';
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
    await startSpecReview(core, worktree, recorded);
    const decision = `approve-spec:${recorded.version}`;
    const choice = await core.decide(decision, approvalDetail(core, recorded), ['approve', 'revise'], () =>
      collectSpecReview(core, worktree, recorded, decision),
    );
    collectSpecReview(core, worktree, recorded, null);
    if (!core.state.specReviews.has(recorded.version)) {
      await core.stopStage(stageKey('spec-review', recorded.version), 'the user decided first');
      core.record({
        type: 'spec_review.recorded',
        specVersion: recorded.version,
        report: null,
        error: 'stopped: the user decided before the review finished',
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
    const spec = parseSpec(text);
    const version = core.state.specs.length + 1;
    const path = join(core.store.dir, 'spec', `v${version}.md`);
    keepEvidence(source, path);
    core.record({
      type: 'spec.recorded',
      key,
      version,
      hash: spec.hash,
      path,
      checks: spec.block.checks,
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

async function startSpecReview(core: DriverCore, worktree: string, spec: SpecVersion): Promise<void> {
  const assignment = core.state.recipe.specReview;
  if (!assignment || core.state.specReviews.has(spec.version)) return;
  const key = stageKey('spec-review', spec.version);
  const reportPath = workerFile(worktree, key, 'report.json');
  await core.launchStage({
    key,
    stage: 'spec-review',
    round: spec.version,
    title: `Spec review v${spec.version}: ${core.state.title}`,
    spec: () => specReviewPrompt({ specPath: spec.path, reportPath }),
    launch: { assignment },
  });
}

/**
 * Record the spec review once its worker has ended. While the decision is pending (`decision` set), a
 * blocking finding or a failed review raises the request again so the user hears about it.
 */
function collectSpecReview(core: DriverCore, worktree: string, spec: SpecVersion, decision: string | null): void {
  const key = stageKey('spec-review', spec.version);
  const record = core.state.stages.get(key);
  const dispatch = currentDispatch(record);
  if (!record || core.state.specReviews.has(spec.version)) return;
  if (!record.startFailure && !dispatch?.settled && !dispatch?.exited) return;
  const reportPath = workerFile(worktree, key, 'report.json');
  recordSpecReview(core, spec, reportPath, dispatch?.settled ?? null, record.startFailure?.error ?? null);
  const review = core.state.specReviews.get(spec.version);
  const blocking = review?.report?.findings.some(finding => finding.severity === 'blocking') ?? false;
  if (decision && (blocking || review?.error))
    core.requestDecision(decision, approvalDetail(core, spec), ['approve', 'revise']);
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

function approvalDetail(core: DriverCore, spec: SpecVersion): string {
  const review = core.state.specReviews.get(spec.version);
  const blocking = review?.report?.findings.filter(finding => finding.severity === 'blocking').length ?? 0;
  const reviewText = review
    ? review.report
      ? `spec review: ${review.report.verdict}, ${blocking} blocking of ${review.report.findings.length} findings`
      : `spec review unavailable: ${review.error ?? 'unknown'}`
    : core.state.recipe.specReview
      ? 'spec review still running (approve now or wait for its findings)'
      : 'no spec review';
  return `Approve spec version ${spec.version} (${spec.path}); ${reviewText}.`;
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
