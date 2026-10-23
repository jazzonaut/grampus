// Read-only explanation and follow-up stages. Their results are evidence about one candidate, never
// part of its correctness verdict. The command id fixes each stage key across driver restarts.
import { join } from 'node:path';
import { explanationLimits } from '../config/limits.js';
import { answerSchema, explanationSchema, type CodeReference } from '../domain/explanation.js';
import type { UserCommand } from '../domain/events.js';
import { git, headSha, lineChanges, uncommittedPaths } from '../git/git.js';
import type { DriverCore } from './driver-core.js';
import { keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';
import { DriverStop, TaskAbandoned } from './driver-core.js';
import { LockLost } from '../store/driver-lock.js';

type ReviewCommand = Extract<UserCommand, { kind: 'explain' | 'ask' }>;

/** Reject a queued review request if the candidate or spec moved before the driver picked it up. */
export async function reviewRefusal(core: DriverCore, command: ReviewCommand): Promise<string | null> {
  const workspace = core.state.workspace;
  if (!workspace) return 'the task has no worktree';
  if (workspace.baseSha !== command.baseSha) return 'the task base changed';
  if (core.state.specs.at(-1)?.version !== command.specVersion) return 'the spec version changed';
  if ((await headSha(workspace.path)) !== command.candidateSha) return 'the candidate changed; refresh Changes';
  const verified =
    [...core.state.verify.values()].some(run => run.sha === command.candidateSha) ||
    [...core.state.simplify.values()].some(pass => pass.decided?.kept && pass.decided.sha === command.candidateSha);
  if (!verified) return 'the candidate has not been verified';
  if (!core.state.finished && !['ready:', 'escalate:'].some(prefix => core.state.attention?.reason.startsWith(prefix)))
    return 'wait until the final candidate is ready for review';
  if (command.kind === 'ask' && !core.state.explanations.get(command.candidateSha)?.explanation)
    return 'explain this candidate before asking a follow-up';
  return null;
}

/** Run one read-only worker and record either its validated result or the failure. */
export async function runReviewCommand(core: DriverCore, command: ReviewCommand): Promise<void> {
  const worktree = core.state.workspace?.path;
  if (!worktree) throw new Error('The task has no worktree.');
  const key = `${command.kind === 'explain' ? 'explain' : 'answer'}:${command.id}`;
  // A builder's already-dirty worktree needs repair, not a read-only explanation. Once this review
  // has started, however, dirt may be its own edit and must still stop acceptance across restarts.
  if (
    !core.state.stages.has(key) &&
    (await headSha(worktree)) === command.candidateSha &&
    (await uncommittedPaths(worktree)).length
  ) {
    const error =
      'Explanation unavailable while the candidate has uncommitted files. Continue with repair or clean the worktree before requesting it again.';
    recordReviewResult(core, command, null, error);
    core.log(error);
    return;
  }
  await assertCandidateUnchanged(worktree, command.candidateSha);
  const reportPath = workerFile(worktree, key, 'report.json');
  const prompt = changeReviewPrompt(core, command, reportPath);
  let result: unknown;
  let error: string | null = null;
  try {
    const settled = await core.runOptionalStage(
      {
        key,
        stage: command.kind === 'explain' ? 'explain' : 'answer',
        round: core.state.guard.size - 1,
        title: `${command.kind === 'explain' ? 'Explain' : 'Answer'}: ${core.state.title}`,
        spec: () => prompt,
        launch: { assignment: core.state.recipe.explain.assignment },
      },
      () => !core.state.finished && !core.state.attention,
    );
    if ('error' in settled) throw new Error(settled.error);
    if (settled.outcome !== 'succeeded') throw new Error(`The worker reported failure: ${settled.body}`);
    const text = readWorkerFile(reportPath);
    if (!text) throw new Error('The worker did not write a report.');
    if (Buffer.byteLength(text) > explanationLimits.bytes) throw new Error('The report exceeds the explanation limit.');
    result = await parseReviewReport(command, text, worktree);
    keepEvidence(reportPath, join(core.store.dir, 'explanations', `${command.id}.json`));
  } catch (failure) {
    if (failure instanceof DriverStop || failure instanceof TaskAbandoned || failure instanceof LockLost) throw failure;
    result = null;
    error = (failure as Error).message;
  }
  // An optional report failure is harmless; a changed candidate invalidates verification. Do not
  // record completion, so a restarted driver checks the same binding before accepting anything.
  await assertCandidateUnchanged(worktree, command.candidateSha);
  recordReviewResult(core, command, result, error);
  core.log(
    error
      ? `${command.kind} unavailable: ${error}`
      : `${command.kind} recorded for ${command.candidateSha.slice(0, 12)}.`,
  );
}

/** Stop rather than attributing earlier verification to work changed by a read-only worker. */
async function assertCandidateUnchanged(worktree: string, candidateSha: string): Promise<void> {
  if ((await headSha(worktree)) !== candidateSha || (await uncommittedPaths(worktree)).length)
    throw new DriverStop(
      `The review candidate changed or has uncommitted files. Restore the clean candidate ${candidateSha} before resuming.`,
    );
}

/** Worker contract for explanations and later questions. Changes here affect measured results. */
function changeReviewPrompt(core: DriverCore, command: ReviewCommand, reportPath: string): string {
  const specPath = core.state.specs.at(-1)?.path ?? '';
  if (command.kind === 'explain')
    return `Explain the committed change for an experienced programmer new to this area. Read the spec at ${specPath}, the request, relevant unchanged architecture and the full Git diff with git diff ${command.baseSha} ${command.candidateSha}. Do not edit code or commit. Distinguish recorded rationale from your inference; do not invent considered alternatives. Cover original problem, concrete before/after behaviour, architecture, approach, meaningful decisions and trade-offs, validation and uncertainty. Organise by purpose across files. Write JSON to ${reportPath} with string fields problem, beforeAfter, architecture, approach, decisions, validation, limitations and groups: array of {id, title, purpose, references:[{path,start,end}]}. References must name changed files and new-file line numbers at ${command.candidateSha}; every group needs at least one. Keep all changed files accessible even when not in a group. Request: ${core.state.request}`;
  const explanation = core.state.explanations.get(command.candidateSha)?.explanation;
  return `Answer the user's question about the committed change at ${command.candidateSha}. Read the spec at ${specPath}, the code and explanation below. Do not edit code or commit. Write JSON to ${reportPath} with {"answer":"...","references":[{"path":"...","start":1,"end":1}]}. References must name changed files and line numbers in the candidate. Say when evidence is insufficient. Question: ${command.question}\nGroup: ${command.groupId ?? 'whole task'}\nSelected code: ${JSON.stringify(command.reference)}\nExplanation: ${JSON.stringify(explanation)}`;
}

/** Parse only complete reports whose references resolve at the candidate commit. */
async function parseReviewReport(command: ReviewCommand, text: string, worktree: string): Promise<unknown> {
  if (command.kind === 'explain') {
    const report = explanationSchema.parse(JSON.parse(text));
    await validateReferences(
      worktree,
      command.baseSha,
      command.candidateSha,
      report.groups.flatMap(group => group.references),
    );
    return report;
  }
  const report = answerSchema.parse(JSON.parse(text));
  await validateReferences(worktree, command.baseSha, command.candidateSha, report.references);
  return report;
}

/** A reference must actually resolve to lines in the recorded candidate. */
async function validateReferences(
  worktree: string,
  baseSha: string,
  sha: string,
  references: CodeReference[],
): Promise<void> {
  const lengths = new Map<string, number>();
  const changed = new Set((await lineChanges(worktree, baseSha, sha)).map(file => file.path));
  for (const reference of references) {
    if (!changed.has(reference.path)) throw new Error(`Reference ${reference.path} is not in the candidate diff.`);
    let length = lengths.get(reference.path);
    if (length === undefined) {
      const source = await git(worktree, ['show', `${sha}:${reference.path}`]);
      length = source === '' ? 0 : source.replace(/\r?\n$/, '').split(/\r?\n/).length;
      lengths.set(reference.path, length);
    }
    if (reference.end > length)
      throw new Error(`Reference ${reference.path}:${reference.end} is outside the candidate.`);
  }
}

/** Keep both report kinds in the same versioned event stream. */
function recordReviewResult(core: DriverCore, command: ReviewCommand, result: unknown, error: string | null): void {
  const binding = {
    commandId: command.id,
    baseSha: command.baseSha,
    candidateSha: command.candidateSha,
    specVersion: command.specVersion,
  };
  if (command.kind === 'explain') {
    core.record({
      type: 'explanation.recorded',
      ...binding,
      explanation: result as ReturnType<typeof explanationSchema.parse> | null,
      error,
    });
  } else {
    core.record({
      type: 'answer.recorded',
      ...binding,
      question: command.question,
      groupId: command.groupId,
      reference: command.reference,
      answer: result as ReturnType<typeof answerSchema.parse> | null,
      error,
    });
  }
}
