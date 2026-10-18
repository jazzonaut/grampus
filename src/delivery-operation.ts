import { writeFileSync } from 'node:fs';
import { Store } from './store.js';
import { Workspaces } from './workspaces.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import type { Delivery } from './deliveries.js';
import { snapshotRepository } from './artifacts.js';
import { deliveryGit, gitText, verifyTree, verifyCommit, verifyNoChange, deliveryMessage, type DeliveryRequest } from './delivery-git.js';

/** Runs inside the supervised writer. Orca owns worktree lifecycle; Git owns commits. */
export async function deliverRepository(request: DeliveryRequest, messageFile: string,
  workspaceFactory: (store: Store) => Workspaces = store => new Workspaces(store)): Promise<string | null> {
  if (request.mode !== undefined && !['commit', 'no_change'].includes(request.mode)) throw new Error('Unsupported delivery mode');
  const binding = request.orca;
  const store = binding ? new Store(binding.database) : null;
  try {
    const workspaces = store ? workspaceFactory(store) : null;
    const fence = () => {
      if (!store || !binding || !workspaces) return;
      const execution = store.execution<Execution>(binding.executionId);
      const workspace = workspaces.get(binding.workspaceId);
      const delivery = store.delivery<Delivery>(request.id);
      const lease = store.lease<ExecutionLease>(binding.workspaceId);
      if (execution.workspaceId !== workspace.id || execution.role !== 'implementation' || execution.phase !== 'open'
        || workspace.adapter !== 'orca' || workspace.phase !== 'ready' || workspace.orca?.identityKey !== binding.identityKey
        || workspace.path !== request.cwd || `refs/heads/${workspace.branch}` !== request.branch || workspace.baseCommit !== request.base
        || delivery.executionId !== execution.id || delivery.phase !== 'running' || delivery.dispatch !== 'requested'
        || JSON.stringify(delivery.request) !== JSON.stringify(request)
        || lease?.kind !== 'delivery' || lease.executionId !== execution.id || lease.runId !== request.id) throw new Error('Orca delivery no longer owns the approved workspace');
    };
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
    if (snapshot.artifact !== request.snapshot.artifact || gitText(request.cwd, 'symbolic-ref', 'HEAD') !== request.branch) throw new Error('Repository changed before delivery dispatch');
    if (request.mode === 'no_change') {
      verifyNoChange(request);
      await inspect();
      const again = await snapshotRepository(request.cwd, request.base);
      if (again.artifact !== request.snapshot.artifact) throw new Error('Repository changed while verifying no-change delivery');
      verifyNoChange(request);
      return null;
    }
    await inspect();
    deliveryGit(request.cwd, 'add', '--all', '--', '.');
    verifyTree(request.cwd, request.snapshot);
    await inspect();
    if (gitText(request.cwd, 'rev-parse', 'HEAD') !== request.snapshot.head) throw new Error('HEAD changed before commit');
    writeFileSync(messageFile, deliveryMessage(request));
    deliveryGit(request.cwd, 'commit', '--cleanup=verbatim', '--file', messageFile);
    return verifyCommit(request);
  } finally { store?.close(); }
}
