// Owns returning a guided task to a new implementation attempt (automatic repair or explicit retry)
// and the checks that make an explicit retry safe to adopt a workspace a person has touched. A retry
// never replays a turn or check: it closes the attempt's executions and the next attempt starts afresh.
import { checkOutputLimits } from '../../config/limits.js';
import { assertTaskExecutionIdle } from '../../execution/execution-state.js';
import { verifyEditingScope } from '../../execution/edit-policy.js';
import { Sessions } from '../../execution/sessions.js';
import { snapshotRepository, type RepositorySnapshot } from '../../repository/artifacts.js';
import { checkFeedback, checkIssue, outputExcerpt } from '../../verification/check-output.js';
import { workspacePath, type GuidedContext } from './context.js';
import { required, type GuidedState } from './state.js';
import { automatic, preparationSpec } from './specs.js';
import { guidedSnapshot, requireGuidedSnapshot } from './snapshots.js';

/** What a retry needs: everything in the handler context except retry itself. */
export type RetryContext = Omit<GuidedContext, 'prepareRetry'>;

/**
 * Compact, bounded evidence from the failed attempt for the next implementer turn: the failing check
 * (or the stop note), the previous reply, the latest review verdict and any answers given but not yet
 * delivered. Those answers belong to the closed session's questions, so the new attempt can only
 * receive them here; dropping them would silently lose a person's decision.
 */
function retryFeedback({ store, checks, executions }: RetryContext, state: GuidedState): string {
  const sessions = new Sessions(store);
  const previous = state.executionId ? sessions.get(executions.get(state.executionId).sessionId).lastReply : null;
  const failedCheck = state.failedCheckId
    ? checks.get(state.failedCheckId)
    : state.executionId
      ? store.checks(state.executionId).findLast(check => check.phase === 'failed')
      : null;
  // While a step runs, the note only names it ("Running review."); a review repair's reason is its verdict.
  const note =
    state.status === 'running'
      ? state.reviewId
        ? 'The independent review raised blocking findings; see review.'
        : null
      : outputExcerpt(state.note, checkOutputLimits.feedbackCharacters);
  const answers = state.answers;
  const undelivered = answers
    ? (previous?.questions ?? []).flatMap(question =>
        answers[question.id] === undefined ? [] : [{ question: question.prompt, answer: answers[question.id] }],
      )
    : [];
  return JSON.stringify({
    reason: failedCheck ? checkIssue(failedCheck) : note,
    ...(undelivered.length ? { answeredQuestions: undelivered } : {}),
    check: failedCheck ? checkFeedback(failedCheck) : null,
    readiness: state.executionId
      ? store
          .checks(state.executionId)
          .filter(
            check =>
              check.purpose === 'readiness' &&
              check.phase === 'failed' &&
              check.spec.artifact === state.snapshot?.artifact,
          )
          .map(check => checkFeedback(check))
      : [],
    implementation: previous ? outputExcerpt(previous.text, checkOutputLimits.feedbackCharacters) : null,
    review: state.reviewId ? sessions.get(executions.get(state.reviewId).sessionId).lastReply : null,
  });
}

/**
 * Closes the attempt's executions and returns to `execution` with feedback, keeping the slice's
 * conversations for resumption. Automatic repairs anchor the next attempt to the failed artifact;
 * an explicit retry may pass the snapshot it verified, which then becomes the anchor. Executions are
 * closed and the state changed in one transaction. Throws when the task has no guided plan or the
 * runner is no longer owned.
 */
export function prepareRetry(context: RetryContext, type: string, explicitSnapshot?: RepositorySnapshot): void {
  const { id, store, workflow, executions, change } = context;
  store.transaction(() => {
    const state = workflow.get(id).guided;
    if (!state) throw new Error('This task has no guided plan');
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
      // Supervised mode needs no anchor: the person authorizes the next attempt's scope explicitly.
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
      current.assessments = [];
      current.answers = null;
      // The failure is now in the feedback; a later stop of the new attempt must not quote it again.
      current.failedCheckId = null;
      current.reviewCycle.arbitrating = false;
    });
  });
}

/**
 * The workspace snapshot an explicit retry of a stopped implementation adopts. The person may have
 * staged files, which is accepted, but HEAD, repository instructions and the file scope must still
 * match. Returns undefined when the task did not stop in an implementation or edit quality pass turn
 * with a policy. Throws when an operation holds the task's lease or the workspace no longer matches
 * the retained HEAD, instructions or file scope.
 */
export async function implementationRetrySnapshot(
  { store, workspaces }: RetryContext,
  state: GuidedState,
): Promise<RepositorySnapshot | undefined> {
  if (
    (state.stage !== 'implementation' && state.stage !== 'quality_pass') ||
    !state.executionId ||
    !state.snapshot ||
    !state.policy
  )
    return;
  const workspace = workspaces.get(required(state, 'workspaceId'));
  const cwd = workspacePath(workspaces, state);
  // The failed execution is settled and cannot acquire another operation lease.
  // The controller owns the task; bind this read to the next leased scope step.
  assertTaskExecutionIdle(store, workspace.taskId);
  await workspaces.inspect(workspace.id, false);
  const snapshot = await snapshotRepository(cwd, workspace.baseCommit);
  assertTaskExecutionIdle(store, workspace.taskId);
  // An explicit retry accepts the user's staging, while preserving HEAD,
  // instruction and file-scope guards. Automatic repairs keep their old anchor.
  const anchor = requireGuidedSnapshot(store, state);
  verifyEditingScope({ cwd, policy: state.policy, snapshot: { ...anchor, index: snapshot.index } }, snapshot);
  return snapshot;
}

/**
 * The snapshot an explicit retry of a stopped preparation continues from. A failed preparation may
 * have changed files only within its approved scope (a slice refresh); initial preparation may not
 * have changed repository inputs at all, so the retry would otherwise adopt unapproved bytes. Throws
 * when the workspace breaks either rule.
 */
export async function preparationRetrySnapshot(
  { checks, store, workspaces }: RetryContext,
  state: GuidedState,
): Promise<RepositorySnapshot> {
  const snapshot = await checks.snapshot(required(state, 'executionId'));
  const current = guidedSnapshot(store, state);
  if (!state.snapshot || !current) return snapshot;
  const spec = preparationSpec(state, current, store.checks(required(state, 'executionId')));
  if (spec.preparation?.scope)
    verifyEditingScope(
      {
        cwd: workspacePath(workspaces, state),
        snapshot: current,
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

/**
 * A review turn that failed or was interrupted produced no verdict, so the verified candidate is still
 * owed one. The review runs again in a fresh review execution on the same attempt, resuming the
 * reviewer where the policy allows, instead of a new implementation attempt and its checks. The
 * workspace must still hold exactly the reviewed artifact.
 */
export async function prepareReviewRetry(context: RetryContext, state: GuidedState): Promise<void> {
  const { store, checks, executions, change } = context;
  const snapshot = await checks.snapshot(required(state, 'executionId'));
  const checked = required(state, 'snapshot');
  if (snapshot.artifact !== checked.artifact || snapshot.instructionsDigest !== checked.instructionsDigest)
    throw new Error('The workspace changed since the candidate was verified; use Retry repair for a new attempt');
  store.transaction(() => {
    const reviewId = state.reviewId;
    if (reviewId && executions.get(reviewId).phase !== 'closed') executions.close(reviewId);
    change('guided.review_retry_requested', current => {
      current.reviewContinuation = reviewId ?? current.reviewContinuation;
      current.reviewId = null;
      current.stage = 'review_execution';
      current.status = 'ready';
      current.stopReason = null;
      current.note = '';
    });
  });
}
