// Owns the `workspace` stage: creating the task worktree (Git or Orca) and adopting it only when it
// matches the approved plan exactly.
import { GuidedStopError } from '../stop-reasons.js';
import { adoptOne, mismatch, type StageHandler } from '../context.js';

/**
 * Creates the worktree once. A released reservation means creation provably did not happen, so the
 * stage stays at `workspace` for an explicit new attempt rather than replaying creation.
 */
export const workspaceStage: StageHandler = {
  known: ({ id, workspaces }) =>
    workspaces
      .list()
      .filter(item => item.taskId === id && item.phase !== 'released')
      .map(item => item.id),
  async perform({ id, state, workspaces }) {
    const config = state.plan.workspace;
    if (config.adapter === 'orca') await workspaces.createOrca(id, state.version, config.repo, config.base);
    else await workspaces.create(id, state.version, config.repo, config.path!, config.base);
    return null;
  },
  settle({ id, state, pending, workspaces }) {
    const result = adoptOne(
      workspaces.list().filter(item => item.taskId === id),
      pending,
    );
    if (!result) return { kind: 'missing' };
    if (result.phase === 'released')
      return {
        kind: 'advance',
        next: 'workspace',
        update: current => {
          current.note =
            'Unused reservation released. Continue explicitly to create a new workspace; no creation was replayed.';
        },
      };
    if (result.phase !== 'ready')
      throw new GuidedStopError('OPERATION_NEEDS_RECOVERY', `Workspace needs recovery: ${result.id}`);
    const config = state.plan.workspace;
    if (
      result.version !== state.version ||
      result.adapter !== config.adapter ||
      result.repository !== config.repo ||
      result.baseCommit !== config.base ||
      (config.adapter === 'git' && result.path !== config.path)
    )
      throw mismatch('Workspace result differs from the approved guided plan');
    return {
      kind: 'advance',
      next: 'execution',
      update: current => {
        current.workspaceId = result.id;
      },
    };
  },
};
