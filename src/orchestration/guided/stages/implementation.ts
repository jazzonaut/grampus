// Owns the `implementation` stage: the supervised editing turn within the exact authorized policy,
// and adopting its settled artifact, questions or failure. It never adopts a result produced under
// any policy other than the one authorized.
import { Implementations, type ImplementationRun } from '../../../execution/implementations.js';
import { boundedRepositoryFiles } from '../../../repository/repository-evidence.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { withReason, type StopReasonCode } from '../stop-reasons.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, workspacePath, type StageHandler } from '../context.js';
import { required } from '../state.js';
import { implementationPrompt } from '../prompts.js';
import { afterEditing, currentSlice, editPolicy } from '../specs.js';
import { keepSnapshot } from '../snapshots.js';
import { withGuidance } from '../guidance.js';
import { pendingDiagnosticAllowance } from '../../../execution/diagnostic-allowance.js';
import { focusedRepairOutcome } from '../focused-repair.js';

/**
 * Why an implementation turn stopped. A turn refused for its prompt budget never reached a provider, so
 * it is named before anything else. Staging is told apart from other failures by its snapshots
 * (same HEAD and instructions, different index) because it needs a different action: finish
 * staging, then retry, rather than inspecting a failed edit. Edit quality passes share the rule and
 * name their own codes for other failures.
 */
export function failureCode(
  result: ImplementationRun,
  failed: StopReasonCode = 'IMPLEMENTATION_FAILED',
  interrupted: StopReasonCode = 'IMPLEMENTATION_INTERRUPTED',
): StopReasonCode {
  if (result.result?.refused === 'prompt_budget') return 'PROMPT_BUDGET_EXCEEDED';
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
  known: ({ store }, state) => store.implementations(required(state, 'executionId')).map(item => item.id),
  async perform({ state, store, workspaces, services, signal }) {
    await new Implementations(store, workspaces).run(
      required(state, 'executionId'),
      required(state, 'policy'),
      withGuidance(
        implementationPrompt({ slicePreparation: currentSlice(state).preparation, feedback: state.feedback }),
        state,
      ),
      { signal, timeoutMs: 0, ...(state.answers ? { answers: state.answers } : {}) },
      services.implementationRunner,
    );
    return null;
  },
  settle(context) {
    const { state, pending, store, workspaces } = context;
    const executionId = required(state, 'executionId');
    const result = adoptOne(store.implementations(executionId), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, executionId, result.id, pending);
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
        workspacePath(workspaces, state),
        after,
        state.plan.context.files,
        state.plan.context.exploration,
      ),
    );
    // The turn consumed any answers; later steps bind to the artifact it left.
    const update = (current: typeof state) => {
      current.answers = null;
      current.snapshot = keepSnapshot(store, after);
    };
    const allowance = pendingDiagnosticAllowance(store, executionId, result.id);
    if (allowance)
      return {
        kind: 'wait',
        next: 'implementation',
        status: 'blocked',
        update,
        reason: {
          code: 'DIAGNOSTIC_ALLOWANCE_REQUIRED',
          note: `${allowance.family} exhausted ${allowance.from} attempts. ${allowance.to > allowance.from ? `Approve ${allowance.to - allowance.from} additional focused attempts (${allowance.to} total) with the diagnostic allowance action.` : 'The fixed diagnostic ceiling is reached; revise the plan.'} Ordinary answers do not change diagnostic permissions.`,
        },
      };
    if (result.result?.reply?.kind === 'question')
      return {
        kind: 'wait',
        next: 'implementation',
        status: 'awaiting_answer',
        reason: { code: 'AGENT_QUESTION', note: 'Answer the implementation questions with task-answer.' },
        update,
      };
    const focused = focusedRepairOutcome(context, result, update);
    if (focused) return focused;
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
