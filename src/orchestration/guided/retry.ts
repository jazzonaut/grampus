// Owns returning a guided task to a new implementation attempt (automatic repair or explicit retry)
// and the checks that make an explicit retry safe to adopt a workspace a person has touched.
import { checkOutputLimits } from '../../config/limits.js';
import { assertTaskExecutionIdle } from '../../execution/execution-state.js';
import { verifyEditingScope } from '../../execution/edit-policy.js';
import { Sessions } from '../../execution/sessions.js';
import { snapshotRepository, type RepositorySnapshot } from '../../repository/artifacts.js';
import type { RepositoryCheck } from '../../verification/checks.js';
import { checkFeedback, checkIssue, outputExcerpt } from '../../verification/check-output.js';
import type { GuidedContext } from './context.js';
import type { GuidedState } from './state.js';
import { automatic, preparationSpec } from './specs.js';

/** What a retry needs: everything in the handler context except retry itself. */
export type RetryContext = Omit<GuidedContext, 'prepareRetry'>;

/**
 * Compact, bounded evidence from the failed attempt for the next implementer turn: the failing check
 * (or the stop note), the previous reply and the latest review verdict.
 */
function retryFeedback({ store, checks, executions }: RetryContext, state: GuidedState): string {
  const sessions = new Sessions(store);
  const previous = state.executionId ? sessions.get(executions.get(state.executionId).sessionId).lastReply : null;
  const failedCheck = state.failedCheckId
    ? checks.get(state.failedCheckId)
    : state.executionId
      ? store.checks<RepositoryCheck>(state.executionId).findLast(check => check.phase === 'failed')
      : null;
  return JSON.stringify({
    reason: failedCheck ? checkIssue(failedCheck) : outputExcerpt(state.note, checkOutputLimits.feedbackCharacters),
    check: failedCheck ? checkFeedback(failedCheck) : null,
    implementation: previous ? outputExcerpt(previous.text, checkOutputLimits.feedbackCharacters) : null,
    review: state.reviewId ? sessions.get(executions.get(state.reviewId).sessionId).lastReply : null,
  });
}

/**
 * Closes the attempt's executions and returns to `execution` with feedback, keeping the slice's
 * conversations for resumption. Automatic repairs anchor the next attempt to the failed artifact;
 * an explicit retry may pass the snapshot it verified, which then becomes the anchor.
 */
export function prepareRetry(context: RetryContext, type: string, explicitSnapshot?: RepositorySnapshot): void {
  const { id, store, workflow, executions, change } = context;
  store.transaction(() => {
    const state = workflow.get(id).guided!;
    const feedback = retryFeedback(context, state);
    if (state.reviewId && executions.get(state.reviewId).phase !== 'closed') executions.close(state.reviewId);
    if (state.executionId && executions.get(state.executionId).phase !== 'closed') executions.close(state.executionId);
    change(type, current => {
      current.feedback = feedback;
      current.stage = current.workspaceId ? 'execution' : 'workspace';
      current.status = 'ready';
      current.pending = null;
      current.implementationContinuation = state.executionId;
      current.reviewContinuation = state.reviewId ?? state.reviewContinuation;
      const anchor = explicitSnapshot ?? state.snapshot;
      current.retryAnchor =
        automatic(state) && anchor
          ? { artifact: anchor.artifact, instructionsDigest: anchor.instructionsDigest }
          : null;
      current.executionId = null;
      current.reviewId = null;
      current.validationId = null;
      current.snapshot = null;
      current.policy = null;
      current.assessment = null;
      current.answers = null;
      current.reviewCycle.arbitrating = false;
    });
  });
}

/**
 * The workspace snapshot an explicit retry of a stopped implementation adopts. The person may have
 * staged files, which is accepted, but HEAD, repository instructions and the file scope must still
 * match. Returns undefined when the task did not stop in an implementation with a policy.
 */
export async function implementationRetrySnapshot(
  { store, workspaces }: RetryContext,
  state: GuidedState,
): Promise<RepositorySnapshot | undefined> {
  if (state.stage !== 'implementation' || !state.executionId || !state.snapshot || !state.policy) return;
  const workspace = workspaces.get(state.workspaceId!);
  // The failed execution is settled and cannot acquire another operation lease.
  // The controller owns the task; bind this read to the next leased scope step.
  assertTaskExecutionIdle(store, workspace.taskId);
  await workspaces.inspect(workspace.id, false);
  const snapshot = await snapshotRepository(workspace.path!, workspace.baseCommit);
  assertTaskExecutionIdle(store, workspace.taskId);
  // An explicit retry accepts the user's staging, while preserving HEAD,
  // instruction and file-scope guards. Automatic repairs keep their old anchor.
  verifyEditingScope(
    { cwd: workspace.path!, policy: state.policy, snapshot: { ...state.snapshot, index: snapshot.index } },
    snapshot,
  );
  return snapshot;
}

/**
 * The snapshot an explicit retry of a stopped preparation continues from. A failed preparation may
 * have changed files only within its approved scope (a slice refresh); initial preparation may not
 * have changed repository inputs at all, so the retry would otherwise adopt unapproved bytes.
 */
export async function preparationRetrySnapshot(
  { checks, workspaces }: RetryContext,
  state: GuidedState,
): Promise<RepositorySnapshot> {
  const snapshot = await checks.snapshot(state.executionId!);
  if (!state.snapshot) return snapshot;
  const spec = preparationSpec(state);
  if (spec.preparation?.scope)
    verifyEditingScope(
      {
        cwd: workspaces.get(state.workspaceId!).path!,
        snapshot: state.snapshot,
        policy: {
          ...spec.preparation.scope,
          artifact: state.snapshot.artifact,
          instructionsDigest: state.snapshot.instructionsDigest,
        },
      },
      snapshot,
    );
  else if (
    snapshot.artifact !== state.snapshot.artifact ||
    snapshot.instructionsDigest !== state.snapshot.instructionsDigest
  )
    throw new Error('Preparation changed repository inputs; inspect and revise the plan before retrying');
  return snapshot;
}
