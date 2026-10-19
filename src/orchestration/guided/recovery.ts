// Owns explicit recovery of the leaf operation a stopped controller may have left behind, before the
// controller settles its own pending step. It never sends a turn, reruns a command or repeats a Git
// write: each leaf's own recovery adopts only what durable records prove.
import { Implementations } from '../../execution/implementations.js';
import { Deliveries } from '../../execution/deliveries.js';
import { Sessions } from '../../execution/sessions.js';
import type { GuidedContext } from './context.js';

/**
 * Recovers unfinished workspace creation and then whichever leaf operation holds the workspace
 * lease, each through its own recovery, which needs settlement proof and never replays dispatch.
 * Snapshot, submission, assessment and completion leases are read-only (they never dispatch a
 * repository-writing tool), so they are released once the controller is provably dead, without a
 * receipt; the only other kind is a `conversation` lease, recovered through its session.
 */
export async function recoverLeafOperations({ id, store, workspaces, executions, checks }: GuidedContext) {
  const workspace = workspaces.list().find(item => item.taskId === id);
  if (workspace && !['ready', 'released'].includes(workspace.phase)) await workspaces.recover(workspace.id);
  const lease = workspace ? store.lease(workspace.id) : null;
  if (!lease) return;
  if (lease.kind === 'implementation') await new Implementations(store, workspaces).recover(lease.runId);
  else if (lease.kind === 'delivery') await new Deliveries(store, workspaces).recover(lease.runId);
  else if (lease.kind === 'check' || lease.kind === 'verification') checks.recover(lease.runId);
  else if (lease.readOnlyRecovery) executions.recoverReadOnly(lease.executionId);
  else new Sessions(store).recover(lease.sessionId);
}
