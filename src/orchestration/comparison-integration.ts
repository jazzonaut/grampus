// Owns explicit fast-forward integration after manual selection. Intent is durable before Git may
// write; uncertain writes are reconciled from repository evidence and are never issued again.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Store } from '../persistence/store.js';
import { verifiedDeliveryHead } from '../domain/delivery-outcome.js';
import { currentProcessStartedAt } from '../process/process-identity.js';
import { gitText, verifyTree } from '../repository/delivery-git.js';
import { snapshotRepository } from '../repository/artifacts.js';
import { processAlive } from '../verification/check-recovery.js';
import { changeComparison, requireComparisonDecision } from './comparisons.js';

function selectedCommit(store: Store, id: string, expected: string) {
  const value = store.comparison(id);
  requireComparisonDecision(value, expected);
  if (value.owner || value.status !== 'complete' || !value.preferredTaskId)
    throw new Error('Select a settled verified run first');
  const run = value.runs.find(item => item.taskId === value.preferredTaskId);
  const task = store.get(value.preferredTaskId);
  if (
    !run ||
    task.version !== run.version ||
    task.phase !== 'complete' ||
    task.guided?.digest !== run.digest ||
    task.guided.status !== 'complete'
  )
    throw new Error('Selected result changed or is no longer verified');
  const deliveries = store.executions(task.id).flatMap(item => store.deliveries(item.id));
  const delivery = deliveries.findLast(item => item.phase === 'delivered');
  const commit = delivery ? verifiedDeliveryHead(delivery) : null;
  if (!commit) throw new Error('Selected result has no verified delivery commit');
  return { value, task, commit };
}

/** The explicit Git target shown before integration; refusal leaves every repository unchanged. */
export function integrationPreview(store: Store, id: string, expected: string) {
  const { value, commit } = selectedCommit(store, id, expected);
  const repository = value.plan.workspace.repo;
  return {
    repository,
    branch: gitText(repository, 'symbolic-ref', 'HEAD'),
    base: gitText(repository, 'rev-parse', 'HEAD'),
    commit,
  };
}

/** Fast-forwards an unchanged, clean source branch once, preserving an uncertain intent on failure. */
export async function integrateComparison(
  store: Store,
  id: string,
  expected: string,
  target: ReturnType<typeof integrationPreview>,
) {
  const value = store.comparison(id);
  requireComparisonDecision(value, expected);
  if (value.integration)
    throw new Error('Integration was already requested; reconcile its retained result without replaying Git');
  const current = integrationPreview(store, id, expected);
  if (JSON.stringify(current) !== JSON.stringify(target))
    throw new Error('Integration target changed; inspect its current branch and HEAD');
  if (target.base !== value.plan.workspace.base)
    throw new Error('Working branch advanced from the comparison base; integrate the chosen branch manually');
  if (gitText(target.repository, 'status', '--porcelain=v1', '--untracked-files=normal'))
    throw new Error('Working branch must have a clean index and working files');
  // Raw bytes must also match the base; filtered status alone does not prove an unchanged worktree.
  const before = await snapshotRepository(target.repository, target.base);
  verifyTree(target.repository, before, target.base);
  const owner = {
    token: randomUUID(),
    controllerPid: process.pid,
    controllerStartedAt: currentProcessStartedAt(),
    host: hostname(),
  };
  changeComparison(store, id, 'comparison.integration_requested', record => {
    requireComparisonDecision(record, expected);
    if (record.integration || record.preferredTaskId !== value.preferredTaskId)
      throw new Error('Integration decision changed');
    record.integration = { ...target, taskId: value.preferredTaskId ?? '', phase: 'requested', owner, error: null };
  });
  try {
    if (
      gitText(target.repository, 'symbolic-ref', 'HEAD') !== target.branch ||
      gitText(target.repository, 'rev-parse', 'HEAD') !== target.base
    )
      throw new Error('Integration target changed before Git dispatch');
    gitText(target.repository, 'merge', '--ff-only', '--no-edit', target.commit);
    await verifyIntegrated(store, id);
  } catch (error) {
    changeComparison(store, id, 'comparison.integration_uncertain', record => {
      if (!record.integration) throw new Error('Integration intent missing');
      record.integration.phase = 'recovery_required';
      record.integration.error = error instanceof Error ? error.message : String(error);
    });
    throw error;
  }
  return store.comparison(id);
}

async function verifyIntegrated(store: Store, id: string): Promise<void> {
  const integration = store.comparison(id).integration;
  if (!integration) throw new Error('No integration intent');
  const { repository, base, commit, branch } = integration;
  if (gitText(repository, 'symbolic-ref', 'HEAD') !== branch || gitText(repository, 'rev-parse', 'HEAD') !== commit)
    throw new Error('Target branch does not prove integration of the selected commit');
  const snapshot = await snapshotRepository(repository, base);
  verifyTree(repository, snapshot, commit);
  verifyTree(repository, snapshot);
  changeComparison(store, id, 'comparison.integrated', record => {
    if (!record.integration || record.integration.owner.token !== integration.owner.token)
      throw new Error('Integration owner changed');
    record.integration.phase = 'integrated';
    record.integration.error = null;
  });
}

/** Reconciles a dead controller's integration from exact Git evidence; never repeats the merge. */
export async function recoverIntegration(store: Store, id: string, expected: string) {
  const value = store.comparison(id);
  requireComparisonDecision(value, expected);
  const owner = value.integration?.owner;
  if (!owner || owner.host !== hostname() || processAlive(owner.controllerPid, owner.controllerStartedAt))
    throw new Error('Original integration controller is alive or unverifiable');
  await verifyIntegrated(store, id);
  return store.comparison(id);
}
