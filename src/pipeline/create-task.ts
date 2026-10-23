// Creates a task: its folder and log, an Orca worktree, and the Orca terminal that runs its driver.
import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { suggestTitle } from '../agents/title.js';
import { inputLimits } from '../config/limits.js';
import { availableRecipes } from '../config/settings.js';
import type { Recipe } from '../domain/recipe.js';
import type { CheckDefinition } from '../domain/spec.js';
import { join } from 'node:path';
import { keepEvidence } from './workspace-files.js';
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
  /** A recipe snapshot to use instead of looking `recipeName` up, as comparisons do. */
  recipe?: Recipe;
  /** The command line that runs this task's driver. The driver closes its own tab when the task finishes. */
  driveCommand: (taskId: string) => string;
  /** For a comparison entry: the comparison, the commit every entry starts from, and the shared spec. */
  comparison?: { comparisonId: string; baseSha: string | null; spec: InheritedSpec | null };
}

/** A spec approved in one comparison entry and given to its siblings. */
export interface InheritedSpec {
  /** Immutable acceptance-test commit shared before any implementation. */
  tests?: { sha: string; files: string[] };
  fromTask: string;
  fromVersion: number;
  path: string;
  hash: string;
  checks: CheckDefinition[];
  protected: string[];
}

export async function createTask(
  input: NewTask,
  workspaces: OrcaWorkspaces,
): Promise<{ taskId: string; repository: string; worktree: string; terminal: string }> {
  const request = input.request.trim();
  if (!request || request.length > inputLimits.requestLength)
    throw new Error(`The request must be between 1 and ${inputLimits.requestLength} characters.`);
  const recipe = input.recipe ?? findRecipe(input.recipeName ?? 'standard');
  const repoRoot = await resolveRepository(input.repoPath);
  const title = await taskTitle(request, input.title);
  const taskId = `${slug(title)}-${randomBytes(3).toString('hex')}`;
  const store = TaskStore.create(input.dataDir, taskId);
  const comparison = input.comparison;
  store.append({
    type: 'task.created',
    taskId,
    title,
    request,
    repoPath: repoRoot,
    recipe,
    ...(comparison ? { comparison: { comparisonId: comparison.comparisonId } } : {}),
  });
  const worktree = await workspaces.createWorktree({
    repoPath: repoRoot,
    name: `grampus-${taskId}`,
    ...(comparison?.baseSha ? { baseRef: comparison.baseSha } : {}),
  });
  const baseSha = await headSha(worktree.path);
  // Entries of one comparison must start from the same commit, or their results are not comparable.
  if (comparison?.baseSha && baseSha !== comparison.baseSha)
    throw new Error(`Task ${taskId}'s worktree starts at ${baseSha}, not the comparison's ${comparison.baseSha}.`);
  await excludeWorkerFolder(worktree.path);
  // Orca opens a first terminal in every new worktree. The driver gets its own tab, so that one is
  // closed: an idle shell left in the worktree would stop Orca from deleting it later.
  const opened = await workspaces.listTerminals(worktree.id).catch(() => []);
  let terminal: string;
  try {
    terminal = await workspaces.createTerminal({
      worktree: { id: worktree.id },
      title: driverTabTitle(title),
      command: input.driveCommand(taskId),
    });
  } catch (error) {
    throw new Error(
      `Task ${taskId} has a worktree at ${worktree.path} but its driver terminal could not be created: ${(error as Error).message}`,
      { cause: error },
    );
  }
  for (const handle of opened) if (handle !== terminal) await workspaces.closeTerminal(handle).catch(() => undefined);
  store.append({
    type: 'workspace.created',
    worktreeId: worktree.id,
    path: worktree.path,
    baseSha,
    driverTerminal: terminal,
  });
  if (comparison?.spec) inheritSpec(store, comparison.spec);
  return { taskId, repository: repoRoot, worktree: worktree.path, terminal };
}

/**
 * The title of the Orca tab Grampus opens for a task's driver. Orca keeps it as the pane title, which is
 * how the dashboard recognises a tab as Grampus's own before closing it.
 */
export function driverTabTitle(title: string): string {
  return `Grampus: ${title}`;
}

/** Copy the shared spec into this entry's task folder and record it, before the driver starts. */
function inheritSpec(store: TaskStore, spec: InheritedSpec): void {
  const path = join(store.dir, 'spec', 'v1.md');
  keepEvidence(spec.path, path);
  if (spec.tests) store.append({ type: 'tests.inherited', fromTask: spec.fromTask, ...spec.tests });
  store.append({
    type: 'spec.inherited',
    fromTask: spec.fromTask,
    fromVersion: spec.fromVersion,
    hash: spec.hash,
    path,
    checks: spec.checks,
    protected: spec.protected,
  });
}

/**
 * The main checkout of the repository containing `path`, so a task can start from any folder or linked
 * worktree inside it (such as the workspace a chat runs in). Orca knows repositories by that checkout.
 */
export async function resolveRepository(path: string): Promise<string> {
  const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (basename(common) !== '.git') throw new Error(`${path} is not inside a repository with a working checkout.`);
  return dirname(common);
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

/**
 * The title a task or comparison gets: the one given, else one a small model suggests, else the request's
 * first line. It also names the task id, worktree and branch, so it is settled before anything exists.
 */
export async function taskTitle(request: string, given: string | undefined): Promise<string> {
  const title = given?.trim() || (await suggestTitle(request)) || firstLine(request);
  return title.slice(0, inputLimits.titleLength);
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
