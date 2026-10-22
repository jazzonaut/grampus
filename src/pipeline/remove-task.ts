// Removes a task: its Orca worktree when asked, then its folder with the event log and every piece of
// evidence. Nothing is archived. Only finished tasks are removed, unless forced, and never while a driver
// runs; workers of an unfinished task are not stopped, since only its driver acts on its Run.
import { rmSync } from 'node:fs';
import { OrcaUncertainError, type OrcaWorkspaces } from '../orca/client.js';
import { acquireDriverLock, type DriverLock } from '../store/driver-lock.js';
import { TaskStore } from '../store/task-store.js';
import { foldEvents } from './state.js';

export interface RemoveOptions {
  /** Also remove the task's worktree. Orca deletes its branch only when it can tell the branch is merged. */
  worktree: boolean;
  /** Remove an unfinished task whose driver is not running, and discard uncommitted changes in its worktree. */
  force: boolean;
}

/** What happened to the worktree: removed now, already gone, left in place, or never created. */
export type WorktreeOutcome = 'removed' | 'already-gone' | 'kept' | 'none';

/**
 * Remove a task. The worktree goes first: when Orca refuses or its answer is unknown, the task stays,
 * so the removal can simply be repeated (a worktree that went anyway is then reported already gone).
 */
export async function removeTask(
  dataDir: string,
  taskId: string,
  options: RemoveOptions,
  workspaces: Pick<OrcaWorkspaces, 'removeWorktree' | 'closeTerminal'>,
): Promise<{ taskId: string; worktree: WorktreeOutcome; worktreePath: string | null }> {
  const store = TaskStore.open(dataDir, taskId);
  // Holding the driver lock refuses a live driver and keeps one from starting while the task goes, so
  // the state read below is the final one.
  let lock: DriverLock;
  try {
    lock = acquireDriverLock(store.dir);
  } catch (error) {
    throw new Error(`Task ${taskId}'s driver is running. Abandon the task, or wait for its driver to stop.`, {
      cause: error,
    });
  }
  try {
    const state = foldEvents(store.events());
    if (state.comparisonId)
      throw new Error(`Task ${taskId} is an entry of comparison ${state.comparisonId}; entries stay with it.`);
    if (!state.finished && !options.force)
      throw new Error(
        `Task ${taskId} has not finished. Abandon it first, or remove it with --force if its driver cannot run (its workers are not stopped).`,
      );
    const workspace = state.workspace;
    let worktree: WorktreeOutcome = workspace ? 'kept' : 'none';
    if (options.worktree && workspace) {
      // A shell left in the worktree would stop it being deleted; the driver tab is usually closed already.
      await workspaces.closeTerminal(workspace.driverTerminal).catch(() => undefined);
      worktree = (await removeWorktree(workspaces, workspace, options.force)) ? 'removed' : 'already-gone';
    }
    // The log first: without it the folder is no longer a task, so an interrupted removal lists nothing.
    rmSync(store.eventsPath, { force: true });
    rmSync(store.dir, { recursive: true, force: true });
    return { taskId, worktree, worktreePath: workspace?.path ?? null };
  } finally {
    lock.release();
  }
}

async function removeWorktree(
  workspaces: Pick<OrcaWorkspaces, 'removeWorktree'>,
  workspace: { worktreeId: string; path: string },
  force: boolean,
): Promise<boolean> {
  try {
    return await workspaces.removeWorktree(workspace.worktreeId, { force });
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof OrcaUncertainError)
      throw new Error(
        `Could not tell whether Orca removed ${workspace.path} (${message}). The task stays; run it again.`,
        {
          cause: error,
        },
      );
    const hint = force ? '' : ' Pass --force to discard uncommitted changes, or keep the worktree.';
    throw new Error(`Orca did not remove ${workspace.path}: ${message}. The task stays.${hint}`, { cause: error });
  }
}
