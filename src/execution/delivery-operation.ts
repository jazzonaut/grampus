// Owns the Git writes of one delivery inside the supervised worker: staging, verifying the staged tree
// against the checked snapshot and committing, or verifying an unchanged head for a no-change
// delivery. For an Orca workspace every step is fenced on the live journal lease first.
import { writeFileSync } from 'node:fs';
import { Store } from '../persistence/store.js';
import type { Delivery, Execution, ExecutionLease, Workspace } from '../persistence/records.js';
import { Workspaces } from '../repository/workspaces.js';
import { snapshotRepository } from '../repository/artifacts.js';
import {
  deliveryGit,
  gitText,
  verifyTree,
  verifyCommit,
  verifyNoChange,
  deliveryMessage,
  type DeliveryRequest,
} from '../repository/delivery-git.js';

type OrcaBinding = NonNullable<DeliveryRequest['orca']>;

/** The workspace is still the ready Orca worktree, branch and base the request was made for. */
function workspaceMatches(workspace: Workspace, request: DeliveryRequest, binding: OrcaBinding): boolean {
  return (
    workspace.adapter === 'orca' &&
    workspace.phase === 'ready' &&
    workspace.orca?.identityKey === binding.identityKey &&
    workspace.path === request.cwd &&
    `refs/heads/${workspace.branch}` === request.branch &&
    workspace.baseCommit === request.base
  );
}

/**
 * The journaled delivery is still this dispatched request, and its lease is still held. The request is
 * compared by its serialised bytes on purpose: the worker runs the request file the controller wrote
 * from this exact record, so any byte difference means the file is not the request that was dispatched.
 */
function deliveryMatches(
  delivery: Delivery,
  lease: ExecutionLease | null,
  execution: Execution,
  request: DeliveryRequest,
): boolean {
  return (
    delivery.executionId === execution.id &&
    delivery.phase === 'running' &&
    delivery.dispatch === 'requested' &&
    JSON.stringify(delivery.request) === JSON.stringify(request) &&
    lease?.kind === 'delivery' &&
    lease.executionId === execution.id &&
    lease.runId === request.id
  );
}

/**
 * Runs inside the supervised writer and returns the new commit (null for a no-change delivery). Orca
 * owns the worktree lifecycle; Git owns commits. Throws, without retrying, when the workspace, HEAD or
 * files no longer match the request.
 */
export async function deliverRepository(
  request: DeliveryRequest,
  messageFile: string,
  workspaceFactory: (store: Store) => Workspaces = store => new Workspaces(store),
): Promise<string | null> {
  if (request.mode !== undefined && !['commit', 'no_change'].includes(request.mode))
    throw new Error('Unsupported delivery mode');
  // Only an Orca request opens the journal; a plain Git delivery relies on the controller's lease alone.
  const binding = request.orca;
  const store = binding ? new Store(binding.database) : null;
  try {
    const workspaces = store ? workspaceFactory(store) : null;
    const fence = () => {
      if (!store || !binding || !workspaces) return;
      const execution = store.execution(binding.executionId);
      const workspace = workspaces.get(binding.workspaceId);
      if (
        execution.workspaceId !== workspace.id ||
        execution.role !== 'implementation' ||
        execution.phase !== 'open' ||
        !workspaceMatches(workspace, request, binding) ||
        !deliveryMatches(store.delivery(request.id), store.lease(binding.workspaceId), execution, request)
      )
        throw new Error('Orca delivery no longer owns the approved workspace');
    };
    // Fenced on both sides of the Orca inspection, since the journal may change while it is awaited.
    const inspect = async () => {
      fence();
      if (workspaces && binding) {
        const observed = await workspaces.inspect(binding.workspaceId, false);
        if (!observed.taskCurrent) throw new Error('Orca delivery task approval changed');
      }
      fence();
    };
    await inspect();
    const snapshot = await snapshotRepository(request.cwd, request.base);
    if (
      snapshot.artifact !== request.snapshot.artifact ||
      gitText(request.cwd, 'symbolic-ref', 'HEAD') !== request.branch
    )
      throw new Error('Repository changed before delivery dispatch');
    if (request.mode === 'no_change') {
      verifyNoChange(request);
      await inspect();
      const again = await snapshotRepository(request.cwd, request.base);
      if (again.artifact !== request.snapshot.artifact)
        throw new Error('Repository changed while verifying no-change delivery');
      verifyNoChange(request);
      return null;
    }
    await inspect();
    deliveryGit(request.cwd, 'add', '--all', '--', '.');
    verifyTree(request.cwd, request.snapshot);
    await inspect();
    if (gitText(request.cwd, 'rev-parse', 'HEAD') !== request.snapshot.head)
      throw new Error('HEAD changed before commit');
    writeFileSync(messageFile, deliveryMessage(request));
    deliveryGit(request.cwd, 'commit', '--cleanup=verbatim', '--file', messageFile);
    return verifyCommit(request);
  } finally {
    store?.close();
  }
}
