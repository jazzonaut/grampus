// Owns the `implementation` stage: the supervised editing turn within the exact authorized policy,
// and adopting its settled artifact, questions or failure.
import { Implementations, type ImplementationRun } from '../../../execution/implementations.js';
import { boundedRepositoryFiles } from '../../../repository/repository-evidence.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { withReason, type StopReasonCode } from '../stop-reasons.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { implementationPrompt } from '../prompts.js';
import { afterEditing, currentSlice, editPolicy } from '../specs.js';

/**
 * Why an implementation turn stopped. Staging is told apart from other failures by its snapshots
 * (same HEAD and instructions, different index) because it needs a different action: finish
 * staging, then retry, rather than inspecting a failed edit. Edit quality passes share the rule and
 * name their own codes for other failures.
 */
export function failureCode(
  result: ImplementationRun,
  failed: StopReasonCode = 'IMPLEMENTATION_FAILED',
  interrupted: StopReasonCode = 'IMPLEMENTATION_INTERRUPTED',
): StopReasonCode {
  const { before, after } = result;
  if (
    before &&
    after &&
    after.head === before.head &&
    after.instructionsDigest === before.instructionsDigest &&
    after.index !== before.index
  )
    return 'CHECKPOINT_CHANGED';
  return result.phase === 'interrupted' ? interrupted : failed;
}

/**
 * Guided implementation turns have no deadline (`timeoutMs: 0`); a stalled turn is stopped
 * explicitly. The result is adopted only under the exact policy that was authorized.
 */
export const implementationStage: StageHandler = {
  known: ({ store }, state) => store.implementations<ImplementationRun>(state.executionId!).map(item => item.id),
  async perform({ state, store, workspaces, services, signal }) {
    await new Implementations(store, workspaces).run(
      state.executionId!,
      state.policy!,
      implementationPrompt({ slicePreparation: currentSlice(state).preparation, feedback: state.feedback }),
      { signal, timeoutMs: 0, ...(state.answers ? { answers: state.answers } : {}) },
      services.implementationRunner,
    );
    return null;
  },
  settle(context) {
    const { state, pending, store, workspaces } = context;
    const result = adoptOne(store.implementations<ImplementationRun>(state.executionId!), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, state.executionId!, result.id, pending);
    if (!deepEqual(result.policy, state.policy))
      throw mismatch('Implementation result differs from the authorized file policy');
    requireSettled(result, 'Implementation');
    if (result.phase !== 'completed' || !result.after)
      return {
        kind: 'stop',
        reason: {
          code: failureCode(result),
          note:
            result.error ??
            result.result?.error ??
            `Implementation ${result.phase}; inspect partial files and use task-retry.`,
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
    const update = (current: typeof state) => {
      current.answers = null;
      current.snapshot = after;
    };
    if (result.result?.reply?.kind === 'question')
      return {
        kind: 'wait',
        next: 'implementation',
        status: 'awaiting_answer',
        reason: { code: 'AGENT_QUESTION', note: 'Answer the implementation questions with task-answer.' },
        update,
      };
    const next = afterEditing(state, after);
    return {
      kind: 'advance',
      next,
      update: current => {
        update(current);
        // An edit pass works on what the implementation left, within the same authorized paths.
        if (next === 'quality_pass') current.policy = editPolicy(current, after);
      },
    };
  },
};
