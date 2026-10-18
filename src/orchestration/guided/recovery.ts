// Owns explicit recovery of the leaf operation a stopped controller may have left behind, before the
// controller settles its own pending step.
import type { ExecutionLease } from '../../execution/execution-state.js';
import { Implementations } from '../../execution/implementations.js';
import { Deliveries } from '../../execution/deliveries.js';
import { Sessions } from '../../execution/sessions.js';
import type { GuidedContext } from './context.js';

/**
 * Recovers unfinished workspace creation and then whichever leaf operation holds the workspace
 * lease, each through its own recovery, which needs settlement proof and never replays dispatch.
 */
export async function recoverLeafOperations({ id, store, workspaces, executions, checks }: GuidedContext) {
  const workspace = workspaces.list().find(item => item.taskId === id);
  if (workspace && !['ready', 'released'].includes(workspace.phase)) await workspaces.recover(workspace.id);
  const lease = workspace ? store.lease<ExecutionLease>(workspace.id) : null;
  if (!lease) return;
  if (lease.kind === 'implementation') await new Implementations(store, workspaces).recover(lease.runId);
  else if (lease.kind === 'delivery') await new Deliveries(store, workspaces).recover(lease.runId);
  else if (lease.kind === 'check' || lease.kind === 'verification') checks.recover(lease.runId);
  else if (lease.readOnlyRecovery) executions.recoverReadOnly(lease.executionId);
  else new Sessions(store).recover(lease.sessionId);
}
