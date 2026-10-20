// Owns retry eligibility shared by the comparison controller and its dashboard projection. A retry
// changes execution, never the approved work contract or a possibly running operation.
import type { Store } from '../persistence/store.js';
import type { Comparison } from '../domain/comparison.js';
import { comparisonDigest, sharedPlanDigest } from '../domain/comparison.js';
import { comparisonRetries } from '../domain/comparison-retries.js';
import { guidedPlanDigest } from '../domain/guided-plan.js';
import { deepEqual } from '../domain/deep-equal.js';
import { isSpendingStop } from './guided/spending.js';

/** A queued repair needs no runner slot, but still needs the same settled, approved task as a retry. */
export function comparisonRetryProblem(store: Store, group: Comparison, taskId: string): string | null {
  if (
    group.approvedDigest !== group.digest ||
    comparisonDigest(group) !== group.digest ||
    sharedPlanDigest(group.plan) !== group.sharedDigest ||
    group.integration
  )
    return 'An approved comparison without requested integration is required to retry a run';
  const task = store.get(taskId),
    state = task.guided;
  if (!state || !currentMember(store, group, taskId))
    return 'Comparison member configuration changed; create a new comparison';
  if (isSpendingStop(state.stopReason?.code))
    return 'Revise the task spending policy and obtain fresh approval before retrying';
  if (!['blocked', 'awaiting_scope', 'awaiting_assessment'].includes(state.status) || state.owner || state.pending)
    return 'Retry requires a settled checkpoint or failure; recover uncertain work first';
  if (store.workspaces().some(workspace => workspace.taskId === taskId && store.lease(workspace.id)))
    return 'Workspace has an active or uncertain execution lease';
  const retries = comparisonRetries(store, group.id);
  return retries.active?.taskId === taskId || retries.pending.some(item => item.taskId === taskId)
    ? 'A repair retry is already queued for this comparison run'
    : null;
}

function currentMember(store: Store, group: Comparison, taskId: string): boolean {
  const task = store.get(taskId),
    state = task.guided;
  const run = group.runs.find(item => item.taskId === taskId);
  return (
    !!state &&
    !!run &&
    !task.deletedAt &&
    task.version === run.version &&
    state.version === run.version &&
    state.digest === run.digest &&
    task.approvedVersion === task.version &&
    state.approvedDigest === state.digest &&
    deepEqual(task.brief, state.plan.brief) &&
    guidedPlanDigest(state.plan) === run.digest
  );
}
