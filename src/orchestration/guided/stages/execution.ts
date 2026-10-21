// Owns the `execution` and `review_execution` stages: binding the current attempt to a fresh
// implementation or review execution, resuming the slice's conversation where the policy allows.
// Implementation and review never share a conversation, and arbitration never resumes one.
import { snapshotRepository } from '../../../repository/artifacts.js';
import { Sessions } from '../../../execution/sessions.js';
import { GuidedStopError } from '../stop-reasons.js';
import {
  adoptOne,
  mismatch,
  type GuidedContext,
  type SettleContext,
  type StageHandler,
  type StageOutcome,
} from '../context.js';
import { required, type GuidedState } from '../state.js';
import { automatic, implementer, reviewer } from '../specs.js';

/**
 * The fallback reason recorded when arbitration uses the implementer's provider. Review normally
 * uses the other provider, so the journal must say why this one does not.
 */
const arbitrationApproval = 'Explicitly approved fresh arbitration after independent blocking review';

/** Every execution of the task, of either role; settlement then picks the new one of its own role. */
function executionIds({ id, executions }: GuidedContext): string[] {
  return executions.list(id).map(item => item.id);
}

/**
 * The first execution of a revised plan's first remaining slice must start from the exact retained
 * workspace that was approved with the revision; anything else means the approval no longer
 * describes the bytes being worked on.
 */
async function requireRevisionAnchor({ id, executions, workspaces }: GuidedContext, state: GuidedState) {
  const revision = state.plan.revision;
  // Only the first execution of the revised version, at the revision's first remaining slice, is
  // compared with the anchor.
  if (
    !revision ||
    state.sliceIndex !== revision.sliceIndex ||
    executions.list(id).some(execution => execution.version === state.version)
  )
    return;
  const workspace = (await workspaces.inspect(required(state, 'workspaceId'), false)).workspace;
  if (!workspace.path) throw new Error(`Workspace ${workspace.id} has no directory`);
  const snapshot = await snapshotRepository(workspace.path, workspace.baseCommit);
  if (
    snapshot.artifact !== revision.artifact ||
    snapshot.head !== revision.head ||
    snapshot.instructionsDigest !== revision.instructionsDigest
  )
    throw new GuidedStopError(
      'REVISION_WORKSPACE_CHANGED',
      'Workspace changed since revised plan approval; revise and approve the current retained changes',
    );
}

/**
 * Adopts the new execution only if it is bound to this version, workspace and attempt, uses the
 * approved provider and model, and has not yet been used for any turn outside this step.
 */
function settleExecution(context: SettleContext, role: 'implementation' | 'review'): StageOutcome {
  const { id, state, pending, executions, workflow, store } = context;
  const result = adoptOne(
    executions.list(id).filter(item => item.role === role),
    pending,
  );
  if (!result) return { kind: 'missing' };
  if (
    result.version !== state.version ||
    result.workspaceId !== state.workspaceId ||
    result.attemptId !== workflow.get(id).attempt?.id
  )
    throw mismatch('Execution result no longer matches the guided task');
  const session = new Sessions(store).get(result.sessionId),
    config = role === 'implementation' ? implementer(context, result.id) : reviewer(state);
  if (
    session.provider !== config.provider ||
    (config.model !== null && session.model !== config.model) ||
    session.effort !== config.effort ||
    store.sessionEvents(session.id).some(event => event.type === 'turn.requested')
  )
    throw mismatch('New execution was changed or used outside this guided step');
  return {
    kind: 'advance',
    next: role === 'implementation' ? (state.plan.preparation ? 'preparation' : 'scope') : 'review',
    update: current => {
      if (role === 'implementation') current.executionId = result.id;
      else current.reviewId = result.id;
    },
  };
}

/** Creates the implementation execution, resuming the slice's implementer conversation in automatic mode. */
export const executionStage: StageHandler = {
  known: executionIds,
  async perform(context) {
    const { state, executions } = context;
    await requireRevisionAnchor(context, state);
    const config = implementer(context);
    await executions.create(required(state, 'workspaceId'), state.version, config.provider, {
      model: config.model,
      ...(config.effort ? { effort: config.effort } : {}),
      resumeFrom: automatic(state) ? state.implementationContinuation : null,
    });
    return null;
  },
  settle: context => settleExecution(context, 'implementation'),
};

/**
 * Creates the review execution. The reviewer conversation resumes only when the provider is
 * unchanged; arbitration always starts fresh so it cannot inherit the reviewer's conclusions.
 */
export const reviewExecutionStage: StageHandler = {
  known: executionIds,
  async perform({ state, store, executions }) {
    const config = reviewer(state);
    const continuation =
      state.reviewContinuation &&
      new Sessions(store).get(executions.get(state.reviewContinuation).sessionId).provider === config.provider
        ? state.reviewContinuation
        : null;
    await executions.create(required(state, 'workspaceId'), state.version, config.provider, {
      role: 'review',
      model: config.model,
      ...(config.effort ? { effort: config.effort } : {}),
      fallbackReason:
        state.reviewCycle.arbitrating && config.provider === state.plan.implementation.provider
          ? arbitrationApproval
          : null,
      resumeFrom: automatic(state) && !state.reviewCycle.arbitrating ? continuation : null,
      arbitration: state.reviewCycle.arbitrating,
    });
    return null;
  },
  settle: context => settleExecution(context, 'review'),
};
