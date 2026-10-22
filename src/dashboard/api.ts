// The dashboard's JSON API. Reads come from the task logs; every write either queues a command for the
// task's driver (exactly like the CLI, with source `dashboard`) or performs one of the few actions the CLI
// performs outside a driver.
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { checkLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { commandGroups, commands, globalOptions } from '../commands.js';
import { queueCommand } from '../control.js';
import { headSha, lineChanges, patch } from '../git/git.js';
import { buildScorecard } from '../measure/report.js';
import { measureDispatches } from '../measure/usage.js';
import type { Orca, OrcaDesk, OrcaHealth, OrcaWorkspaces } from '../orca/client.js';
import { listTaskIds } from '../store/task-store.js';
import {
  deleteRecipe,
  listModels,
  listRecipes,
  listRepos,
  mergeTask,
  openInOrca,
  putRecipe,
  resumeComparison,
  resumeTask,
  removeTaskRoute,
  startTask,
  startComparisonRoute,
  comparisonCommandRoute,
} from './actions.js';
import { comparisonDetail, comparisonList, comparisonMetrics } from './comparisons.js';
import { listComparisonIds } from '../compare/comparison.js';
import { readHealth, type OrcaProbe } from './health.js';
import { HttpError, readJson, sendJson, sendText, startEvents } from './http.js';
import type { LoadedTask, TaskReader, TaskWatcher } from './tasks.js';
import type { ChangesView, DiffView, HelpView, LiveChange, ScorecardView, TaskList } from './types.js';
import { listItem, readBounded, servableFiles, taskDetail } from './views.js';

/** The Orca calls the dashboard makes itself. */
export type DashboardOrca = Pick<Orca, 'transcriptSessions'> & OrcaWorkspaces & OrcaDesk & OrcaHealth;

/** What every route can use. */
export interface DashboardApp {
  dataDir: string;
  /** The command line that runs this CLI, for driver terminals of tasks started from the dashboard. */
  selfCommand: string;
  reader: TaskReader;
  watcher: TaskWatcher;
  orca: DashboardOrca;
  probe: OrcaProbe;
}

export interface Call {
  app: DashboardApp;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: string[];
}

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: RegExp;
  handle: (call: Call) => Promise<void> | void;
}

const id = '([a-z0-9-]+)';

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/tasks$/, handle: listTasks },
  { method: 'POST', pattern: /^\/api\/tasks$/, handle: startTask },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}$`), handle: showTask },
  { method: 'DELETE', pattern: new RegExp(`^/api/tasks/${id}$`), handle: withTask(removeTaskRoute) },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}/events$`), handle: taskEvents },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}/file$`), handle: taskFile },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}/scorecard$`), handle: taskScorecard },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}/changes$`), handle: taskChanges },
  { method: 'GET', pattern: new RegExp(`^/api/tasks/${id}/diff$`), handle: taskDiff },
  { method: 'POST', pattern: new RegExp(`^/api/tasks/${id}/commands$`), handle: addCommand },
  { method: 'POST', pattern: new RegExp(`^/api/tasks/${id}/merge$`), handle: withTask(mergeTask) },
  { method: 'POST', pattern: new RegExp(`^/api/tasks/${id}/open$`), handle: withTask(openInOrca) },
  { method: 'POST', pattern: new RegExp(`^/api/tasks/${id}/resume$`), handle: withTask(resumeTask) },
  { method: 'GET', pattern: /^\/api\/repos$/, handle: listRepos },
  { method: 'GET', pattern: /^\/api\/recipes$/, handle: listRecipes },
  { method: 'PUT', pattern: /^\/api\/recipes\/([^/]+)$/, handle: putRecipe },
  { method: 'DELETE', pattern: /^\/api\/recipes\/([^/]+)$/, handle: deleteRecipe },
  { method: 'GET', pattern: /^\/api\/models$/, handle: listModels },
  { method: 'GET', pattern: /^\/api\/comparisons$/, handle: listComparisons },
  { method: 'POST', pattern: /^\/api\/comparisons$/, handle: startComparisonRoute },
  { method: 'GET', pattern: new RegExp(`^/api/comparisons/${id}$`), handle: showComparison },
  { method: 'GET', pattern: new RegExp(`^/api/comparisons/${id}/metrics$`), handle: measureComparison },
  { method: 'POST', pattern: new RegExp(`^/api/comparisons/${id}/commands$`), handle: comparisonCommandRoute },
  { method: 'POST', pattern: new RegExp(`^/api/comparisons/${id}/resume$`), handle: resumeComparison },
  { method: 'GET', pattern: /^\/api\/help$/, handle: help },
  { method: 'GET', pattern: /^\/api\/health$/, handle: health },
  { method: 'GET', pattern: /^\/api\/live$/, handle: live },
];

/** Answer an API error with its status and a message the page can show. */
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
  if (error instanceof ZodError)
    return sendJson(response, 400, {
      error: error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '),
    });
  sendJson(response, 500, { error: (error as Error).message });
}

/** Answer 404 for an unknown task before running a handler that needs one. */
function withTask(handle: (call: Call) => Promise<void>): (call: Call) => Promise<void> {
  return call => {
    load(call.app, call.params[0]);
    return handle(call);
  };
}

function load(app: DashboardApp, taskId: string | undefined): LoadedTask {
  if (!taskId || !listTaskIds(app.dataDir).includes(taskId))
    throw new HttpError(404, `Task ${taskId ?? ''} was not found.`);
  return app.reader.load(taskId);
}

function listTasks({ app, response }: Call): void {
  const asOf = new Date().toISOString();
  const { tasks, unreadable } = app.reader.loadAll();
  const body: TaskList = {
    asOf,
    tasks: tasks.map(task => listItem(task.state, task.events)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    unreadable,
  };
  sendJson(response, 200, body);
}

function showTask({ app, response, params }: Call): void {
  const task = load(app, params[0]);
  sendJson(response, 200, taskDetail(task.state, task.events, task.store.commands()));
}

function taskEvents({ app, response, params }: Call): void {
  sendJson(response, 200, load(app, params[0]).events);
}

/** A spec version or check log of the task. Only paths the task's log records are served. */
function taskFile({ app, response, params, url }: Call): void {
  const task = load(app, params[0]);
  const path = url.searchParams.get('path') ?? '';
  if (!servableFiles(task.state).has(path)) throw new HttpError(404, 'That file is not part of this task.');
  const text = readBounded(path, checkLimits.logBytes);
  if (text === null) throw new HttpError(404, 'The file no longer exists.');
  sendText(response, 200, text);
}

/** The recorded scorecard of a finished task, or one measured now (provisional) for a running task. */
async function taskScorecard({ app, response, params }: Call): Promise<void> {
  const task = load(app, params[0]);
  const measurements = task.state.measurements ?? (await measureDispatches(task.state, app.orca));
  const body: ScorecardView = {
    ...buildScorecard(task.state, task.events, measurements),
    asOf: new Date().toISOString(),
  };
  sendJson(response, 200, body);
}

/** The task's worktree with the base commit and the commit it is at now. */
async function branchOf(task: LoadedTask): Promise<{ worktree: string; baseSha: string; sha: string }> {
  const workspace = task.state.workspace;
  if (!workspace || !existsSync(workspace.path)) throw new HttpError(404, 'The task has no worktree.');
  return { worktree: workspace.path, baseSha: workspace.baseSha, sha: await headSha(workspace.path) };
}

/** Lines added and deleted per file on the task's branch so far. Uncommitted work is not counted. */
async function taskChanges({ app, response, params }: Call): Promise<void> {
  const { worktree, baseSha, sha } = await branchOf(load(app, params[0]));
  const body: ChangesView = { baseSha, sha, files: await lineChanges(worktree, baseSha, sha) };
  sendJson(response, 200, body);
}

/** The unified diff of the task's branch so far, cut at the configured size. */
async function taskDiff({ app, response, params }: Call): Promise<void> {
  const { worktree, baseSha, sha } = await branchOf(load(app, params[0]));
  const text = Buffer.from(await patch(worktree, baseSha, sha), 'utf8');
  const limit = currentSettings().dashboardDiffBytes;
  const body: DiffView = {
    baseSha,
    sha,
    patch: text.subarray(0, limit).toString('utf8'),
    truncated: text.length > limit,
  };
  sendJson(response, 200, body);
}

async function addCommand({ app, request, response, params }: Call): Promise<void> {
  const task = load(app, params[0]);
  const command = queueCommand(app.dataDir, task.state.taskId, 'dashboard', await readJson(request));
  sendJson(response, 202, command);
}

function listComparisons({ app, response }: Call): void {
  sendJson(response, 200, { asOf: new Date().toISOString(), comparisons: comparisonList(app.dataDir) });
}

function knownComparison(app: DashboardApp, comparisonId: string | undefined): string {
  if (!comparisonId || !listComparisonIds(app.dataDir).includes(comparisonId))
    throw new HttpError(404, `Comparison ${comparisonId ?? ''} was not found.`);
  return comparisonId;
}

function showComparison({ app, response, params }: Call): void {
  sendJson(response, 200, comparisonDetail(app.dataDir, app.reader, knownComparison(app, params[0])));
}

async function measureComparison({ app, response, params }: Call): Promise<void> {
  const comparisonId = knownComparison(app, params[0]);
  sendJson(response, 200, await comparisonMetrics(app.dataDir, app.reader, app.orca, comparisonId));
}

function help({ response }: Call): void {
  const body: HelpView = {
    groups: Object.entries(commandGroups).map(([group, title]) => ({
      id: group as keyof typeof commandGroups,
      title,
      commands: commands
        .filter(command => command.group === group)
        .map(command => ({
          name: command.name,
          args: command.args,
          summary: command.summary,
          detail: command.detail ?? null,
        })),
    })),
    globalOptions,
  };
  sendJson(response, 200, body);
}

async function health({ app, response }: Call): Promise<void> {
  sendJson(response, 200, await readHealth(app.dataDir, app.reader, app.probe));
}

/** Server-sent events: `hello` on connect, then `change` with the ids of tasks whose logs changed. */
function live({ app, request, response }: Call): void {
  const send = startEvents(response);
  send('hello', { asOf: new Date().toISOString(), tasks: [] } satisfies LiveChange);
  const stop = app.watcher.subscribe(tasks =>
    send('change', { asOf: new Date().toISOString(), tasks } satisfies LiveChange),
  );
  request.on('close', stop);
}
