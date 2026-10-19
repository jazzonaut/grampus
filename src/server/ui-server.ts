// Owns the loopback dashboard server: static client assets, the token-guarded JSON API over the journal
// and the action workers it starts. Request bodies are parsed by api-schemas.ts; failures map to HTTP
// statuses in errors.ts. The server is not a second workflow engine: every decision goes to the controller.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import { StaleStateError } from '../persistence/errors.js';
import { GuidedTasks } from '../orchestration/guided/controller.js';
import { guidedDecisionKey } from '../orchestration/guided/keys.js';
import { guidedTaskView } from '../orchestration/guided-status.js';
import { renderReport } from '../reporting/report.js';
import { Kickoffs } from '../orchestration/kickoff.js';
import { Sessions } from '../execution/sessions.js';
import { versionInformation } from '../config/runtime.js';
import { checkOutputLimits, formatBytes, serverLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { TaskLifecycle } from '../orchestration/task-lifecycle.js';
import { suggestReferenceFolders } from '../repository/reference-folders.js';
import type { Task } from '../domain/workflow.js';
import { availableQualityPasses } from '../domain/quality-passes.js';
import { readCheckLog } from '../verification/check-output.js';
import { describeIssues } from '../process/boundary.js';
import { HttpError, errorResponse } from './errors.js';
import { eventSummary, taskPoll } from './task-poll.js';
import {
  approveTaskBody,
  createKickoffBody,
  createTaskBody,
  decisionBody,
  inspectRepositoryBody,
  kickoffContextBody,
  kickoffReferencesBody,
  lifecycleBody,
  prepareKickoffBody,
  searchFilesBody,
  suggestReferencesBody,
  taskWorkerActions,
  workerActionSchema,
  type WorkerAction,
} from './api-schemas.js';

interface Job {
  running: boolean;
  error: string | null;
  action: string;
  startedAt: string;
}
export interface UiOptions {
  db: string;
  port?: number;
}

const assets: Record<string, [string, string]> = {
  '/': ['src/ui/index.html', 'text/html'],
  '/app.js': ['src/ui/app.js', 'text/javascript'],
  '/app.css': ['src/ui/app.css', 'text/css'],
  '/favicon.svg': ['src/ui/favicon.svg', 'image/svg+xml'],
  '/markdown.js': ['src/ui/markdown.js', 'text/javascript'],
  '/vendor/markdown-it.js': ['node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'text/javascript'],
};
const itemRoute = /^\/api\/(?<kind>tasks|kickoffs)\/(?<id>[a-f0-9-]+)(?:\/(?<action>[a-z-]+))?$/;
const routeSchema = z.object({ kind: z.enum(['tasks', 'kickoffs']), id: z.string(), action: z.string().optional() });
type ItemRoute = z.infer<typeof routeSchema>;
const checkOutputQuery = z.object({
  checkId: z.string().default(''),
  stream: z.enum(['stdout', 'stderr'], { error: 'Invalid log page' }).default('stderr'),
  offset: z.coerce
    .number({ error: 'Invalid log page' })
    .int({ error: 'Invalid log page' })
    .min(0, { error: 'Invalid log page' })
    .default(0),
  raw: z.string().optional(),
});

/** Parse a request body or query with the route's schema; failures are 400 with field-level issues. */
function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new HttpError(400, `Invalid request: ${issues.join('; ')}`, issues);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new HttpError(415, 'Use application/json');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const received: unknown = chunk;
    const buffer = Buffer.isBuffer(received) ? received : Buffer.from(String(received));
    bytes += buffer.length;
    if (bytes > serverLimits.requestBytes)
      throw new HttpError(413, `Request exceeds ${formatBytes(serverLimits.requestBytes)}`);
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Request must be an object');
  return value;
}

/** Everything a request handler needs from one running dashboard. */
interface Dashboard {
  store: Store;
  tasks: GuidedTasks;
  kickoffs: Kickoffs;
  jobs: Map<string, Job>;
  cachedViews: Map<string, { revision: string; value: unknown }>;
  launch: (id: string, work: WorkerAction) => void;
}

function json(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function liveTask(store: Store, id: string): Task {
  const task = store.get<Task>(id);
  if (task.deletedAt) throw new HttpError(404, 'This task was deleted');
  return task;
}

function cachedPoll(dashboard: Dashboard, id: string): unknown {
  const revision = dashboard.store.revision(),
    cached = dashboard.cachedViews.get(id);
  if (cached?.revision === revision) return cached.value;
  const value = taskPoll(dashboard.store, id);
  if (dashboard.cachedViews.size >= serverLimits.cachedTaskViews) {
    const oldest = dashboard.cachedViews.keys().next();
    if (!oldest.done) dashboard.cachedViews.delete(oldest.value);
  }
  dashboard.cachedViews.set(id, { revision, value });
  return value;
}

function getItem(dashboard: Dashboard, route: ItemRoute, url: URL): unknown {
  const { store } = dashboard;
  if (route.kind !== 'tasks') throw new HttpError(404, 'Not found');
  const task = liveTask(store, route.id);
  if (route.action === 'events') return { events: store.events(route.id).map(eventSummary) };
  if (route.action === 'report') return { report: renderReport(store, route.id) };
  if (route.action === 'check-output') {
    const query = parseRequest(checkOutputQuery, Object.fromEntries(url.searchParams));
    const check = store.check(query.checkId);
    if (store.execution(check.executionId).taskId !== task.id)
      throw new HttpError(404, 'Check belongs to another task');
    return readCheckLog(check, query.stream, query.offset, checkOutputLimits.maxPageCharacters, query.raw === '1');
  }
  if (route.action === undefined) return cachedPoll(dashboard, route.id);
  throw new HttpError(404, 'Not found');
}

function postRoot(dashboard: Dashboard, path: string, payload: unknown): [number, unknown] {
  const { kickoffs, tasks } = dashboard;
  switch (path) {
    case '/api/references/suggest':
      return [
        200,
        { suggestions: suggestReferenceFolders(parseRequest(suggestReferencesBody, payload).request ?? '') },
      ];
    case '/api/repositories/inspect': {
      const inspected = kickoffs.inspect(parseRequest(inspectRepositoryBody, payload));
      return [200, { repo: inspected.repo, base: inspected.base, context: inspected.context }];
    }
    case '/api/repositories/files':
      return [200, kickoffs.search(parseRequest(searchFilesBody, payload))];
    case '/api/kickoffs':
      return [201, { id: kickoffs.create(parseRequest(createKickoffBody, payload)) }];
    case '/api/tasks':
      return [201, { id: tasks.create(parseRequest(createTaskBody, payload).plan).id }];
    default:
      throw new HttpError(404, 'Not found');
  }
}

function kickoffAction(dashboard: Dashboard, id: string, action: string, payload: unknown): [number, unknown] {
  const { kickoffs, store } = dashboard;
  const view = kickoffs.view(id);
  const current = (expected: string) => {
    if (expected !== view.turnKey) throw new StaleStateError('Planning state changed; inspect the current discussion');
    return expected;
  };
  switch (action) {
    case 'context': {
      const body = parseRequest(kickoffContextBody, payload);
      return [200, kickoffs.changeContext(id, body.files, current(body.expected))];
    }
    case 'references': {
      const body = parseRequest(kickoffReferencesBody, payload);
      return [200, kickoffs.changeContext(id, view.config.files, current(body.expected), body.references)];
    }
    case 'stop':
      if (!view.session.run) throw new Error('Planner has not started or has already settled; refresh its state');
      new Sessions(store).stop(id, view.session.run.id, 'User requested a stop in the dashboard');
      return [200, { ok: true }];
    case 'prepare': {
      const { digest } = parseRequest(prepareKickoffBody, payload);
      if (view.candidateDigest !== null && digest !== view.candidateDigest)
        throw new StaleStateError('The proposed plan changed; inspect the current proposal before preparing approval');
      return [201, { id: kickoffs.prepare(id, digest) }];
    }
    case 'plan':
    case 'planner-recover': {
      const work = parseRequest(workerActionSchema, { action, payload });
      if (work.action === 'plan') current(work.payload.expected);
      dashboard.launch(id, work);
      return [202, { ok: true }];
    }
    default:
      throw new HttpError(404, 'Unknown kickoff action');
  }
}

function taskAction(dashboard: Dashboard, id: string, action: string, payload: unknown): [number, unknown] {
  const { store, tasks } = dashboard;
  const view = guidedTaskView(store, id);
  if (action === 'stop') {
    tasks.stop(id);
    return [200, { ok: true }];
  }
  // Every decision names the exact state displayed to the user. A stale tab cannot authorize new bytes.
  const expected = guidedDecisionKey(view.state, view.questionKey);
  const decided = parseRequest(decisionBody, payload).expected;
  if (decided !== expected)
    throw new StaleStateError('Task changed since you inspected it; refresh before taking this action');
  if (action === 'approve') {
    const body = parseRequest(approveTaskBody, payload);
    const approved = new GuidedTasks(store, { expectedState: body.expected }).approve(id, body.version, body.digest);
    if (approved.plan.workflowPolicy.mode !== 'automatic') return [200, { ok: true }];
    dashboard.launch(id, { action: 'run', payload: { expected: guidedDecisionKey(approved) } });
    return [202, { ok: true }];
  }
  if (!taskWorkerActions.some(name => name === action)) throw new HttpError(404, 'Unknown task action');
  dashboard.launch(id, parseRequest(workerActionSchema, { action, payload }));
  return [202, { ok: true }];
}

function postItem(dashboard: Dashboard, route: ItemRoute, payload: unknown): [number, unknown] {
  const { action, id, kind } = route;
  if (!action) throw new HttpError(404, 'Not found');
  if (dashboard.jobs.get(id)?.running && action !== 'stop')
    throw new HttpError(409, 'An action is already running; wait for settlement');
  if (action === 'delete' || action === 'reset') {
    const { expected } = parseRequest(lifecycleBody, payload);
    staleLifecycle(dashboard, route, expected);
    const lifecycle = new TaskLifecycle(dashboard.store);
    return [200, action === 'delete' ? lifecycle.delete(kind, id, expected) : lifecycle.reset(kind, id, expected)];
  }
  return kind === 'kickoffs'
    ? kickoffAction(dashboard, id, action, payload)
    : taskAction(dashboard, id, action, payload);
}

/** Lifecycle actions name the state they were decided on; a different current state is a conflict. */
function staleLifecycle(dashboard: Dashboard, route: ItemRoute, expected: string): void {
  if (route.kind === 'kickoffs') {
    const view = dashboard.kickoffs.view(route.id);
    if (!view.taskId && view.turnKey !== expected)
      throw new StaleStateError('Planning state changed; refresh before managing this task');
    return;
  }
  const view = guidedTaskView(dashboard.store, route.id);
  if (!view.task.deletedAt && guidedDecisionKey(view.state, view.questionKey) !== expected)
    throw new StaleStateError('Task changed; refresh before managing it');
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

/** Loopback dashboard. Workers use the same durable controller as the CLI. */
export async function startUi(options: UiOptions) {
  const store = new Store(options.db),
    tasks = new GuidedTasks(store),
    kickoffs = new Kickoffs(store);
  const token = randomBytes(32).toString('hex'),
    jobs = new Map<string, Job>();
  let cachedState: { revision: string; value: { tasks: unknown; kickoffs: unknown } } | null = null;
  let origin = '';
  const launch = (id: string, work: WorkerAction) => {
    if (jobs.get(id)?.running) throw new HttpError(409, 'An action is already running for this item');
    const job: Job = { running: true, error: null, action: work.action, startedAt: new Date().toISOString() };
    jobs.set(id, job);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./ui-worker.js', import.meta.url))], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-serverLimits.workerErrorCharacters);
    });
    child.on('error', error => {
      job.running = false;
      job.error = error.message;
    });
    child.stdin.on('error', error => {
      job.error = error.message;
    });
    child.on('close', code => {
      job.running = false;
      if (code !== 0) job.error = output.trim() || job.error || `Worker exited (${code})`;
    });
    child.stdin.end(JSON.stringify({ db: store.path, id, ...work, settings: currentSettings() }));
  };
  const dashboard: Dashboard = { store, tasks, kickoffs, jobs, cachedViews: new Map(), launch };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    securityHeaders(response);
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      json(response, 403, { error: 'Local origin required' });
      return;
    }
    const url = new URL(request.url ?? '/', origin);
    const path = url.pathname;
    const asset = request.method === 'GET' ? assets[path] : undefined;
    if (asset) {
      const [file, mime] = asset;
      response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      response.end(readFileSync(new URL(`../../../${file}`, import.meta.url)));
      return;
    }
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
      json(response, 401, { error: 'Open the complete local dashboard link printed by Grampus' });
      return;
    }
    const groups = itemRoute.exec(path)?.groups;
    const route = groups ? routeSchema.parse(groups) : null;
    if (request.method === 'GET') {
      if (path === '/api/state') {
        const revision = store.revision();
        if (cachedState?.revision !== revision)
          cachedState = { revision, value: { tasks: store.guidedSummaries(), kickoffs: kickoffs.list() } };
        json(response, 200, {
          ...cachedState.value,
          jobs: Object.fromEntries(jobs),
          journal: store.path,
          application: versionInformation(currentSettings().dashboardPort),
          qualityPasses: availableQualityPasses(currentSettings().qualityPasses),
        });
        return;
      }
      if (!route) throw new HttpError(404, 'Not found');
      json(response, 200, getItem(dashboard, route, url));
      return;
    }
    if (request.method !== 'POST') throw new HttpError(404, 'Not found');
    const payload = await readBody(request);
    const [status, body] = route ? postItem(dashboard, route, payload) : postRoot(dashboard, path, payload);
    json(response, status, body);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const { status, body } = errorResponse(error);
      if (!response.headersSent) json(response, status, body);
      else response.end();
    });
  });
  server.requestTimeout = serverLimits.requestTimeoutMs;
  server.headersTimeout = serverLimits.headersTimeoutMs;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? currentSettings().dashboardPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    url: `${origin}/#${token}`,
    close: async () => {
      if ([...jobs.values()].some(job => job.running))
        throw new Error('An action is still running; stop it and wait for settlement before closing');
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      store.close();
    },
  };
}
