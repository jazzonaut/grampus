// Owns optional patches reconstructed from retained verified commit identities, never from the live
// worktree. Missing Git objects stay explicit while the journal and snapshots remain exportable.
import { deliveryGit } from '../repository/delivery-git.js';
import type { Task } from '../domain/workflow.js';
import type { Delivery } from '../persistence/records.js';
import { verifiedDeliveryHead } from '../domain/delivery-outcome.js';

/** Binary-capable Git patch for all verified deliveries retained by a run. */
export function runPatch(task: Task, deliveries: Delivery[]) {
  const plan = task.guided?.plan;
  const delivery = deliveries.findLast(item => item.phase === 'delivered');
  const commit = delivery ? verifiedDeliveryHead(delivery) : null;
  if (!plan || !commit)
    return { status: 'unavailable' as const, base: plan?.workspace.base ?? null, commit: commit ?? null, patch: null };
  try {
    return {
      status: 'included' as const,
      base: plan.workspace.base,
      commit,
      patch: deliveryGit(
        plan.workspace.repo,
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        plan.workspace.base,
        commit,
        '--',
      ).toString('utf8'),
    };
  } catch {
    return { status: 'unavailable' as const, base: plan.workspace.base, commit, patch: null };
  }
}
