// Owns the `quality_pass` stage: each selected edit pass as a scoped turn by the implementer, after
// the slice's first successful implementation turn and before validation, within the same file paths.
import { Implementations, type ImplementationRun } from '../../../execution/implementations.js';
import { prepareEditing } from '../../../execution/edit-policy.js';
import { boundedRepositoryFiles } from '../../../repository/repository-evidence.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { GuidedStopError, withReason } from '../stop-reasons.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import type { GuidedState, QualityEditRecord } from '../state.js';
import { qualityPassPrompt } from '../prompts.js';
import { afterEditing, currentSlice, editPolicy, pendingEditPass } from '../specs.js';
import { failureCode } from './implementation.js';

function requirePass(state: GuidedState) {
  const pass = pendingEditPass(state);
  if (!pass || !state.policy || !state.snapshot)
    throw new GuidedStopError('RESULT_MISMATCH', 'No edit quality pass is pending for the current slice');
  return pass;
}

/**
 * The pass resumes the implementation conversation (the same execution and session), so the
 * implementer knows what it just changed. Its policy is the slice's authorized paths rebuilt on the
 * implementation's result; the result is adopted only under exactly that policy.
 */
export const qualityPassStage: StageHandler = {
  known: ({ store }, state) => store.implementations<ImplementationRun>(state.executionId!).map(item => item.id),
  async perform({ state, store, workspaces, services, signal }) {
    const pass = requirePass(state);
    const cwd = workspaces.get(state.workspaceId!).path!;
    withReason('SCOPE_REJECTED', () => prepareEditing({ cwd, snapshot: state.snapshot!, policy: state.policy! }));
    await new Implementations(store, workspaces).run(
      state.executionId!,
      state.policy!,
      qualityPassPrompt({ pass, slicePreparation: currentSlice(state).preparation }),
      { signal, timeoutMs: 0, ...(state.answers ? { answers: state.answers } : {}) },
      services.implementationRunner,
    );
    return null;
  },
  settle(context) {
    const { state, pending, store, workspaces } = context;
    const pass = requirePass(state);
    const result = adoptOne(store.implementations<ImplementationRun>(state.executionId!), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, state.executionId!, result.id, pending);
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
    withReason('SCOPE_REJECTED', () =>
      boundedRepositoryFiles(
        workspaces.get(state.workspaceId!).path!,
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
          current.snapshot = after;
          current.policy = editPolicy(current, after);
        },
      };
    const record: QualityEditRecord = {
      pass: pass.id,
      implementationId: result.id,
      before: state.snapshot!.artifact,
      after: after.artifact,
    };
    const next = afterEditing({ ...state, qualityEdits: [...state.qualityEdits, record] }, after);
    return {
      kind: 'advance',
      next,
      update: current => {
        current.answers = null;
        current.snapshot = after;
        current.qualityEdits.push(record);
        if (next === 'quality_pass') current.policy = editPolicy(current, after);
        // Recorded in the same transaction as the state change, so recovery cannot record it twice.
        store.appendExecution(state.executionId!, 'quality_pass.completed', record);
      },
    };
  },
};
