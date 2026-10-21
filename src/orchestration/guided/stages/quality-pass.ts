// Owns the `quality_pass` stage: explicitly assigned edit passes use native workspace access after
// candidate submission and before validation. A settled pass never runs again in the slice;
// unassigned passes are work for the ordinary implementer before it submits a candidate.
import { Implementations, type ImplementationRun } from '../../../execution/implementations.js';
import { prepareEditing } from '../../../execution/edit-policy.js';
import { boundedRepositoryFiles } from '../../../repository/repository-evidence.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { GuidedStopError, withReason } from '../stop-reasons.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, workspacePath, type StageHandler } from '../context.js';
import { required, type GuidedState, type QualityEditRecord } from '../state.js';
import { qualityPassPrompt } from '../prompts.js';
import { afterEditing, currentSlice, editPolicy, pendingEditPass } from '../specs.js';
import { failureCode } from './implementation.js';
import { keepSnapshot, requireGuidedSnapshot } from '../snapshots.js';
import { withGuidance } from '../guidance.js';
import { prepareWorkspaceContinuation } from '../../../execution/workspace-context.js';

/** The pending edit pass with the policy and snapshot it runs under; a pass never runs without both. */
function requirePass(state: GuidedState) {
  const pass = pendingEditPass(state);
  if (!pass || !state.policy || !state.snapshot)
    throw new GuidedStopError('RESULT_MISMATCH', 'No edit quality pass is pending for the current slice');
  return { pass, policy: state.policy, snapshot: state.snapshot };
}

/**
 * The artifact a native pass started from: the latest candidate before `runs`' last entry, which is the
 * implementation's candidate or the previous pass's. Progress turns in between move the slice snapshot
 * but not where the pass began.
 */
function passStart(runs: readonly ImplementationRun[]): string | undefined {
  return runs
    .slice(0, -1)
    .findLast(run => run.phase === 'completed' && run.result?.reply?.kind === 'candidate' && run.after)?.after
    ?.artifact;
}

/**
 * The pass resumes the implementation conversation (the same execution and session), so the
 * implementer knows what it just changed when the model and context policy allow resumption.
 * Its workspace checkpoint is rebuilt on the implementation's result; settlement binds to that policy.
 */
export const qualityPassStage: StageHandler = {
  known: ({ store }, state) => store.implementations(required(state, 'executionId')).map(item => item.id),
  async perform({ state, store, workspaces, services, signal }) {
    const { pass, policy } = requirePass(state);
    if (policy.workspace) prepareWorkspaceContinuation(store, required(state, 'executionId'));
    const cwd = workspacePath(workspaces, state);
    const snapshot = requireGuidedSnapshot(store, state);
    const assignment = state.plan.modelProfile?.qualityPasses?.[pass.id] ?? state.plan.implementation;
    // A previous progress update means this pass is under way; the agent resumes instead of restarting.
    const continuing = store.implementations(required(state, 'executionId')).at(-1)?.result?.reply?.kind === 'message';
    // The policy was rebuilt on the previous turn's result; refuse it before the turn if it no longer fits.
    withReason('SCOPE_REJECTED', () => prepareEditing({ cwd, snapshot, policy }));
    await new Implementations(store, workspaces).run(
      required(state, 'executionId'),
      policy,
      withGuidance(qualityPassPrompt({ pass, slicePreparation: currentSlice(state).preparation, continuing }), state),
      { signal, timeoutMs: 0, stage: 'quality_pass', assignment, ...(state.answers ? { answers: state.answers } : {}) },
      services.implementationRunner,
    );
    return null;
  },
  settle(context) {
    const { state, pending, store, workspaces } = context;
    const { pass, snapshot } = requirePass(state);
    const executionId = required(state, 'executionId');
    const result = adoptOne(store.implementations(executionId), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, executionId, result.id, pending);
    if (!deepEqual(result.policy, state.policy))
      throw mismatch('Quality pass result differs from the authorized file policy');
    requireSettled(result, 'Quality pass');
    if (result.phase !== 'completed' || !result.after)
      return {
        kind: 'stop',
        reason: {
          code: failureCode(result, 'QUALITY_PASS_FAILED', 'QUALITY_PASS_FAILED'),
          note: `Quality pass ${pass.id} ${result.phase}: ${result.error ?? result.result?.error ?? 'no settled artifact'}. Inspect partial files and use task-retry.`,
        },
      };
    const after = result.after;
    if (!result.policy.workspace)
      withReason('SCOPE_REJECTED', () =>
        boundedRepositoryFiles(
          workspacePath(workspaces, state),
          after,
          state.plan.context.files,
          state.plan.context.exploration,
        ),
      );
    if (result.result?.reply?.kind === 'question')
      return {
        kind: 'wait',
        next: 'quality_pass',
        status: 'awaiting_answer',
        reason: { code: 'AGENT_QUESTION', note: 'Answer the quality pass questions with task-answer.' },
        update: current => {
          current.answers = null;
          current.snapshot = keepSnapshot(store, after);
          current.policy = editPolicy(current, after);
        },
      };
    if (result.policy.workspace && result.result?.reply?.kind !== 'candidate')
      return {
        kind: 'advance',
        next: 'quality_pass',
        update: current => {
          current.answers = null;
          current.snapshot = keepSnapshot(store, after);
          current.policy = editPolicy(current, after);
        },
      };
    const runs = store.implementations(executionId);
    const record: QualityEditRecord = {
      pass: pass.id,
      implementationId: result.id,
      before:
        (result.policy.workspace
          ? passStart(runs.slice(0, runs.findIndex(run => run.id === result.id) + 1))
          : undefined) ?? snapshot.artifact,
      after: after.artifact,
    };
    const next = afterEditing({ ...state, qualityEdits: [...state.qualityEdits, record] }, after);
    return {
      kind: 'advance',
      next,
      update: current => {
        current.answers = null;
        current.snapshot = keepSnapshot(store, after);
        current.qualityEdits.push(record);
        if (next === 'quality_pass') current.policy = editPolicy(current, after);
        // Recorded in the same transaction as the state change, so recovery cannot record it twice.
        store.appendExecution(executionId, 'quality_pass.completed', record);
      },
    };
  },
};
