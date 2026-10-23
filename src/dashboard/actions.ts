// Dashboard actions outside a task's command queue: starting, merging and removing a task, bringing
// Orca tabs forward, resuming a stopped driver, and editing recipes. Each does exactly what the matching
// CLI command does.
import { basename } from 'node:path';
import { z } from 'zod';
import { agentCatalogs, type AgentCatalog } from '../agents/catalog.js';
import { listComparisonIds } from '../compare/comparison.js';
import { comparisonTabTitle, startComparison } from '../compare/create.js';
import { queueComparisonCommand } from '../control.js';
import { inputLimits, recipeLimits } from '../config/limits.js';
import { availableRecipes, currentSettings, saveRecipes, useSettings } from '../config/settings.js';
import { mergeAccepted } from '../delivery/merge.js';
import { recipeSchema, standardRecipe, builtInRecipes, type Recipe } from '../domain/recipe.js';
import { OrcaError, OrcaUncertainError } from '../orca/client.js';
import { createTask, driverTabTitle } from '../pipeline/create-task.js';
import { removeTask } from '../pipeline/remove-task.js';
import { loadComparison } from './comparisons.js';
import { HttpError, readJson, sendJson } from './http.js';
import type { Call, DashboardApp } from './api.js';

const newTaskSchema = z
  .object({
    repo: z.string().min(1),
    request: z.string().min(1).max(inputLimits.requestLength),
    title: z.string().max(inputLimits.titleLength).optional(),
    recipe: z.string().min(1).max(recipeLimits.nameLength).optional(),
  })
  .strict();

/** Start a task like `grampus new`: its log, an Orca worktree and the terminal running its driver. */
export async function startTask({ app, request, response }: Call): Promise<void> {
  const input = newTaskSchema.parse(await readJson(request));
  if (input.recipe && !availableRecipes().some(recipe => recipe.name === input.recipe))
    throw new HttpError(400, `Unknown recipe "${input.recipe}".`);
  const created = await createTask(
    {
      dataDir: app.dataDir,
      repoPath: input.repo,
      request: input.request,
      ...(input.title?.trim() ? { title: input.title } : {}),
      ...(input.recipe ? { recipeName: input.recipe } : {}),
      driveCommand: taskId => `${app.selfCommand} drive ${taskId}`,
    },
    app.orca,
  ).catch((error: unknown) => {
    // Orca failing is not the user's mistake; a bad repository path or request is.
    const orca = error instanceof OrcaError || error instanceof OrcaUncertainError;
    throw new HttpError(orca ? 502 : 400, (error as Error).message);
  });
  sendJson(response, 201, created);
}

/** `grampus merge`: fast-forward the checked-out branch to the accepted, verified commit. Never pushes. */
export async function mergeTask({ app, response, params }: Call): Promise<void> {
  const task = app.reader.load(params[0] ?? '');
  try {
    sendJson(response, 200, await mergeAccepted(task.store));
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
}

const removeSchema = z.object({ worktree: z.boolean(), force: z.boolean() }).strict();

/** `grampus remove`: delete the task and its evidence, and its worktree when asked. */
export async function removeTaskRoute({ app, request, response, params }: Call): Promise<void> {
  const options = removeSchema.parse(await readJson(request));
  try {
    sendJson(response, 200, await removeTask(app.dataDir, params[0] ?? '', options, app.orca));
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
}

const openSchema = z.object({ target: z.enum(['terminal', 'changes']) }).strict();

/** Bring the task's driver terminal, or its changed files, forward in the Orca window on this machine. */
export async function openInOrca({ app, request, response, params }: Call): Promise<void> {
  const { target } = openSchema.parse(await readJson(request));
  const workspace = app.reader.load(params[0] ?? '').state.workspace;
  if (!workspace) throw new HttpError(409, 'The task has no worktree yet.');
  try {
    if (target === 'terminal') await app.orca.switchTerminal(workspace.driverTerminal);
    else await app.orca.openChangedFiles(workspace.path);
  } catch (error) {
    const reason = target === 'terminal' ? 'The driver terminal is closed (it closes when the task finishes).' : '';
    throw new HttpError(409, `${reason} ${(error as Error).message}`.trim());
  }
  sendJson(response, 200, { opened: target });
}

/**
 * Resumes asked for lately, by data directory and target, so a second click before the new driver has
 * recorded its start does not open a second tab whose driver the lock would refuse.
 */
const resuming = new Map<string, number>();

interface Resumable {
  /** `task:<id>` or `comparison:<id>`. */
  key: string;
  /** The driver stopped, or went missing, and the task or comparison is not finished. */
  stopped: boolean;
  place: { id: string } | { path: string };
  /** The tab title Grampus gives this driver. */
  tabTitle: string;
  command: string;
  /** The terminal the last driver ran in. */
  previous: string | null;
}

/**
 * Start a stopped driver again in a new Orca tab, as rerunning `grampus drive` by hand would; it continues
 * where it stopped. The old tab is closed only when Orca says Grampus opened it (its pane still carries
 * the title Grampus gave it): a driver run by hand in someone's own terminal leaves that terminal alone.
 */
async function resume(app: DashboardApp, target: Resumable): Promise<string> {
  if (!target.stopped) throw new HttpError(409, 'The driver is running, starting or finished: nothing to resume.');
  const key = `${app.dataDir}|${target.key}`;
  const since = resuming.get(key);
  if (since !== undefined && Date.now() - since < currentSettings().driverStaleMs)
    throw new HttpError(409, 'The driver is already resuming; give it a moment to start.');
  resuming.set(key, Date.now());
  let terminal: string;
  try {
    terminal = await app.orca.createTerminal({
      worktree: target.place,
      title: target.tabTitle,
      command: target.command,
    });
  } catch (error) {
    resuming.delete(key);
    throw new HttpError(502, (error as Error).message);
  }
  const previous = target.previous;
  if (previous && previous !== terminal) {
    const title = await app.orca.terminalTitle(previous).catch(() => null);
    if (title === target.tabTitle) await app.orca.closeTerminal(previous).catch(() => undefined);
  }
  return terminal;
}

/** Resume a task's stopped driver in a new tab in its worktree. */
export async function resumeTask({ app, response, params }: Call): Promise<void> {
  const { state } = app.reader.load(params[0] ?? '');
  const workspace = state.workspace;
  if (!workspace) throw new HttpError(409, 'The task has no worktree yet.');
  const terminal = await resume(app, {
    key: `task:${state.taskId}`,
    stopped: !state.finished && state.lastStop !== null,
    place: { id: workspace.worktreeId },
    tabTitle: driverTabTitle(state.title),
    command: `${app.selfCommand} drive ${state.taskId}`,
    previous: workspace.driverTerminal,
  });
  sendJson(response, 202, { terminal });
}

/** Resume a comparison's stopped driver in a new tab in the repository's main checkout. */
export async function resumeComparison({ app, response, params }: Call): Promise<void> {
  const comparisonId = params[0] ?? '';
  if (!listComparisonIds(app.dataDir).includes(comparisonId))
    throw new HttpError(404, `Comparison ${comparisonId} was not found.`);
  const { state } = loadComparison(app.dataDir, comparisonId);
  const terminal = await resume(app, {
    key: `comparison:${comparisonId}`,
    stopped: !state.finished && state.lastStop !== null,
    place: { path: state.repoPath },
    tabTitle: comparisonTabTitle(state.title),
    command: `${app.selfCommand} drive-comparison ${comparisonId}`,
    previous: state.terminal,
  });
  sendJson(response, 202, { terminal });
}

/** Repositories for the new-task form: ones used by earlier tasks first, then the rest Orca knows. */
export async function listRepos({ app, response }: Call): Promise<void> {
  const recent = new Map<string, string>();
  const tasks = app.reader.loadAll().tasks.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  for (const { state } of tasks) if (!recent.has(state.repoPath)) recent.set(state.repoPath, basename(state.repoPath));
  let orca: { path: string; name: string }[] = [];
  let note: string | null = null;
  try {
    orca = await app.orca.listRepos();
  } catch (error) {
    note = `Orca's repositories are unavailable: ${(error as Error).message}`;
  }
  const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  sendJson(response, 200, {
    repos: [
      ...[...recent].map(([path, name]) => ({ path, name, recent: true })),
      ...orca
        .filter(repo => ![...recent.keys()].some(path => same(path, repo.path)))
        .map(repo => ({ ...repo, recent: false })),
    ],
    note,
  });
}

export function listRecipes({ response }: Call): void {
  sendJson(response, 200, {
    recipes: availableRecipes(),
    builtIn: builtInRecipes.map(recipe => recipe.name),
    defaultRecipe: standardRecipe.name,
    maxRepairRounds: recipeLimits.maxRepairRounds,
    deliveryDefaults: standardRecipe.delivery,
  });
}

function storeRecipes(app: DashboardApp, recipes: Recipe[]): void {
  try {
    useSettings(saveRecipes(app.dataDir, recipes));
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

/** Create or replace a saved recipe; a different name in the body renames it. */
export async function putRecipe({ app, request, response, params }: Call): Promise<void> {
  const name = decodeURIComponent(params[0] ?? '');
  if (builtInRecipes.some(recipe => recipe.name === name))
    throw new HttpError(400, 'The built-in recipe cannot be changed; copy it instead.');
  const recipe = recipeSchema.parse(await readJson(request));
  const saved = currentSettings().recipes;
  if (recipe.name !== name && saved.some(item => item.name === recipe.name))
    throw new HttpError(409, `A recipe named ${recipe.name} already exists.`);
  const exists = saved.some(item => item.name === name);
  storeRecipes(app, exists ? saved.map(item => (item.name === name ? recipe : item)) : [...saved, recipe]);
  sendJson(response, exists ? 200 : 201, recipe);
}

export function deleteRecipe({ app, response, params }: Call): void {
  const name = decodeURIComponent(params[0] ?? '');
  const saved = currentSettings().recipes;
  if (!saved.some(item => item.name === name)) throw new HttpError(404, `No saved recipe is named ${name}.`);
  storeRecipes(
    app,
    saved.filter(item => item.name !== name),
  );
  sendJson(response, 200, { deleted: name });
}

let catalogs: Promise<AgentCatalog[]> | null = null;

/** Models and effort levels per agent. Asking the CLIs is slow, so the answer is kept until `?refresh`. */
export async function listModels({ app, response, url }: Call): Promise<void> {
  if (!catalogs || url.searchParams.has('refresh')) {
    const fromRecipes = availableRecipes().flatMap(recipe =>
      [
        recipe.spec,
        recipe.specReview,
        recipe.testsFirst,
        recipe.build,
        recipe.review,
        recipe.polish,
        recipe.repair.assignment,
      ].flatMap(assignment => (assignment?.agent === 'claude' && assignment.model ? [assignment.model] : [])),
    );
    const measured = app.reader
      .loadAll()
      .tasks.flatMap(task => task.state.measurements ?? [])
      .filter(item => item.provider === 'claude')
      .flatMap(item => item.models);
    catalogs = agentCatalogs([...new Set([...fromRecipes, ...measured])].sort());
  }
  sendJson(response, 200, { agents: await catalogs });
}

const newComparisonSchema = z
  .object({
    repo: z.string().min(1),
    request: z.string().min(1).max(inputLimits.requestLength),
    title: z.string().max(inputLimits.titleLength).optional(),
    recipes: z.array(z.string().min(1).max(recipeLimits.nameLength)).min(2),
    mode: z.enum(['shared', 'full']),
  })
  .strict();

/** Start a comparison like `grampus compare`: its log and the terminal running its driver. */
export async function startComparisonRoute({ app, request, response }: Call): Promise<void> {
  const input = newComparisonSchema.parse(await readJson(request));
  const created = await startComparison(
    {
      dataDir: app.dataDir,
      repoPath: input.repo,
      request: input.request,
      recipeNames: input.recipes,
      mode: input.mode,
      ...(input.title?.trim() ? { title: input.title } : {}),
      driveCommand: comparisonId => `${app.selfCommand} drive-comparison ${comparisonId}`,
    },
    app.orca,
  ).catch((error: unknown) => {
    const orca = error instanceof OrcaError || error instanceof OrcaUncertainError;
    throw new HttpError(orca ? 502 : 400, (error as Error).message);
  });
  sendJson(response, 201, created);
}

/** Pick an entry or abandon the comparison, queued for the comparison's driver. */
export async function comparisonCommandRoute({ app, request, response, params }: Call): Promise<void> {
  const comparisonId = params[0] ?? '';
  if (!listComparisonIds(app.dataDir).includes(comparisonId))
    throw new HttpError(404, `Comparison ${comparisonId} was not found.`);
  sendJson(response, 202, queueComparisonCommand(app.dataDir, comparisonId, 'dashboard', await readJson(request)));
}
