// Creates a task: its folder and log, an Orca worktree, and the Orca terminal that runs its driver.
import { randomBytes } from 'node:crypto';
import { inputLimits } from '../config/limits.js';
import { availableRecipes } from '../config/settings.js';
import type { Recipe } from '../domain/recipe.js';
import { git, headSha } from '../git/git.js';
import type { OrcaWorkspaces } from '../orca/client.js';
import { TaskStore } from '../store/task-store.js';
import { excludeWorkerFolder } from './workspace-files.js';

export interface NewTask {
  dataDir: string;
  repoPath: string;
  request: string;
  title?: string;
  recipeName?: string;
  /** The command line that runs this task's driver. Its terminal closes when the driver finishes cleanly. */
  driveCommand: (taskId: string) => string;
}

export async function createTask(
  input: NewTask,
  workspaces: OrcaWorkspaces,
): Promise<{ taskId: string; worktree: string; terminal: string }> {
  const request = input.request.trim();
  if (!request || request.length > inputLimits.requestLength)
    throw new Error(`The request must be between 1 and ${inputLimits.requestLength} characters.`);
  const recipe = findRecipe(input.recipeName ?? 'standard');
  const repoRoot = (await git(input.repoPath, ['rev-parse', '--show-toplevel'])).trim();
  const title = (input.title?.trim() || firstLine(request)).slice(0, inputLimits.titleLength);
  const taskId = `${slug(title)}-${randomBytes(3).toString('hex')}`;
  const store = TaskStore.create(input.dataDir, taskId);
  store.append({ type: 'task.created', taskId, title, request, repoPath: repoRoot, recipe });
  const worktree = await workspaces.createWorktree({ repoPath: repoRoot, name: `grampus-${taskId}` });
  const baseSha = await headSha(worktree.path);
  await excludeWorkerFolder(worktree.path);
  let terminal: string;
  try {
    terminal = await workspaces.createTerminal({
      worktreeId: worktree.id,
      title: `Grampus: ${title}`,
      // The driver exits 0 only when the task finished; closing the tab then releases the shell that
      // would otherwise hold the worktree open. A stopped driver exits 1 and keeps its tab for a rerun.
      // `&&` works in PowerShell 7, cmd and POSIX shells.
      command: `${input.driveCommand(taskId)} && exit`,
    });
  } catch (error) {
    throw new Error(
      `Task ${taskId} has a worktree at ${worktree.path} but its driver terminal could not be created: ${(error as Error).message}`,
      { cause: error },
    );
  }
  store.append({
    type: 'workspace.created',
    worktreeId: worktree.id,
    path: worktree.path,
    baseSha,
    driverTerminal: terminal,
  });
  return { taskId, worktree: worktree.path, terminal };
}

function findRecipe(name: string): Recipe {
  const recipe = availableRecipes().find(item => item.name === name);
  if (!recipe)
    throw new Error(
      `Unknown recipe "${name}". Available: ${availableRecipes()
        .map(item => item.name)
        .join(', ')}.`,
    );
  return recipe;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? text;
}

/** A short, file-system-safe slug for task ids. */
export function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (words.slice(0, 40).replace(/-+$/g, '') || 'task').replace(/^-+/, '');
}
