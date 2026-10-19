// Owns the loopback dashboard server: the built Vue client (static-client.ts), the token-guarded JSON API
// over the journal and the action workers it starts. The client reads `/api/v1/` (api-v1.ts) and acts
// through the POST routes here. Request bodies are parsed by api-schemas.ts; failures map to HTTP statuses
// and the typed error envelope in errors.ts. The server is not a second workflow engine: every decision
// goes to the controller.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import { StaleStateError } from '../persistence/errors.js';
import { GuidedTasks } from '../orchestration/guided/controller.js';
import { guidedDecisionKey } from '../orchestration/guided/keys.js';
import { assertRunnerAvailable, runnerPool } from '../orchestration/guided/runner-pool.js';
import { guidedTaskView } from '../orchestration/guided-status.js';
import { renderReport } from '../reporting/report.js';
import { Kickoffs } from '../orchestration/kickoff.js';
import { Sessions } from '../execution/sessions.js';
import { OrcaPresentation } from '../repository/orca-presentation.js';
import type { OrcaDesktopClient } from '../repository/orca.js';
import { checkOutputLimits, formatBytes, serverLimits, stallLimits } from '../config/limits.js';
import { currentSettings, saveSettingsFile } from '../config/settings.js';
import { TaskLifecycle } from '../orchestration/task-lifecycle.js';
import { suggestReferenceFolders } from '../repository/reference-folders.js';
import type { Task } from '../domain/workflow.js';
import { outputExcerpt, readCheckLog } from '../verification/check-output.js';
import { describeIssues } from '../process/boundary.js';
import { HttpError, errorResponse } from './errors.js';
import { createApiV1 } from './api-v1.js';
import { listenForBrowsers } from './browser-ports.js';
import type {
  CheckOutputPage,
  CreatedResponse,
  FileSearchResponse,
  InspectRepositoryResponse,
  ReferenceSuggestionsResponse,
  ReportResponse,
} from './api-types.js';
import { defaultClientDirectory, missingClientPage, readClientFile } from './static-client.js';
import { HealthMonitor, healthView, type HealthCheck } from '../health/health.js';
import { StallWatchdog } from '../health/stalls.js';
import { desktopIdentity, type DesktopProfile } from './desktop-discovery.js';
import { DesktopService } from './desktop-service.js';
import {
  approveTaskBody,
  createKickoffBody,
  createTaskBody,
  decisionBody,
  queueGuidanceBody,
  cancelGuidanceBody,
  inspectRepositoryBody,
  kickoffContextBody,
  kickoffReferencesBody,
  lifecycleBody,
  prepareKickoffBody,
  saveSettingsBody,
  searchFilesBody,
  suggestReferencesBody,
  taskWorkerActions,
  workerActionSchema,
  workerFailureSchema,
  type WorkerAction,
  type WorkerActionName,
  type WorkerFailure,
} from './api-schemas.js';

interface Job {
  running: boolean;
  error: string | null;
  action: string;
  startedAt: string;
  /** When the worker settled. Settled jobs are dropped after `serverLimits.settledJobRetentionMs`. */
  settledAt: string | null;
}

/** Worker actions that act on a planning conversation rather than a task. */
const kickoffWorkerActions: readonly WorkerActionName[] = ['plan', 'planner-recover'];

/**
 * Task worker actions that claim a slot in the guided runner pool. Recovery, workspace release and
 * revision never start an agent turn or check, so the controller does not limit them.
 */
const pooledWorkerActions: readonly WorkerActionName[] = [
  'run',
  'authorize',
  'assess',
  'answer',
  'retry',
  'rerun-checks',
];

/** The failure a worker reported on its last stderr line, or its raw stderr tail when it reported none. */
function workerFailure(output: string, fallback: string): WorkerFailure {
  const text = output.trim();
  try {
    const reported = workerFailureSchema.safeParse(JSON.parse(text.split('\n').at(-1)?.trim() ?? ''));
    if (reported.success) return reported.data;
  } catch {
    /* Not a structured report: a crash trace or runtime output. */
  }
  return { error: text || fallback, reasonCode: null };
}

/**
 * Journals a failed dashboard action as `dashboard.action_failed` on its task or planning
 * conversation, so the failure survives a dashboard restart. The message is a bounded plain-text
 * excerpt. Journaling is best effort: the in-memory job error still reports it.
 */
function journalFailure(store: Store, id: string, work: WorkerAction, failure: WorkerFailure, exitCode: number | null) {
  const event = {
    action: work.action,
    note: outputExcerpt(failure.error, serverLimits.workerFailureCharacters),
    reasonCode: failure.reasonCode,
    exitCode,
  };
  try {
    store.transaction(() => {
      if (kickoffWorkerActions.includes(work.action)) store.appendSession(id, 'dashboard.action_failed', event);
      else store.append(id, store.get(id).version, 'dashboard.action_failed', event);
    });
  } catch {
    /* The record may be gone or the journal busy; the job error below is still shown. */
  }
}

/** Drops settled jobs older than the retention period; their failures are already in the journal. */
function pruneJobs(jobs: Map<string, Job>, now = Date.now()): void {
  for (const [id, job] of jobs)
    if (!job.running && job.settledAt && now - Date.parse(job.settledAt) > serverLimits.settledJobRetentionMs)
      jobs.delete(id);
}
export interface UiOptions {
  db: string;
  /**
   * Loopback port; 0 lets the system choose one browsers accept. A port browsers refuse is rejected
   * (see browser-ports.ts). Defaults to the `dashboardPort` setting.
   */
  port?: number;
  /**
   * Integration checks (the CLI passes `doctor`). With it the dashboard checks stale health at start,
   * serves `GET /api/health?refresh=1` and lets run workers check before a guided run. Without it the
   * stored result is shown and a refresh is refused, so tests never start real providers.
   */
  health?: HealthCheck;
  /** Clock for staleness and stall detection; tests inject one. */
  now?: () => number;
  /** The built client folder; defaults to `web/dist` of this installation. Tests pass a fixture. */
  client?: string;
  /**
   * The data directory whose `config.json` the Settings screen reads and saves (the CLI passes its
   * own). Without it the screen shows a disabled form, so tests never touch a developer's settings.
   */
  settingsDirectory?: string;
  /** Optional Orca desktop client. The CLI installs it; tests use an isolated fake or omit it. */
  orca?: OrcaDesktopClient;
  /** Publishes a private receipt for start-or-reconnect; omitted by isolated HTTP tests. */
  desktop?: DesktopProfile;
}

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
  launch: (id: string, work: WorkerAction) => void;
  stalls: StallWatchdog;
  /** Null when the dashboard was started without integration checks. */
  health: HealthMonitor | null;
  now: () => number;
  /** Null when the dashboard was started without a settings file to edit. */
  settingsDirectory: string | null;
  orca: OrcaPresentation | null;
  accessUrl: () => string;
}

/** The built client: index.html, the favicon and hashed assets; a short explanation while it is unbuilt. */
function serveClient(directory: string, path: string, response: ServerResponse): void {
  const file = readClientFile(directory, path);
  if (file) {
    response.writeHead(200, { 'Content-Type': file.type });
    response.end(file.body);
    return;
  }
  if (path !== '/') throw new HttpError(404, 'Not found');
  response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(missingClientPage);
}

function json(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function liveTask(store: Store, id: string): Task {
  const task = store.get(id);
  if (task.deletedAt) throw new HttpError(404, 'This task was deleted');
  return task;
}

/** The two task reads the client makes outside `/api/v1/`: the report and paged check output. */
function getItem(dashboard: Dashboard, route: ItemRoute, url: URL): ReportResponse | CheckOutputPage {
  const { store } = dashboard;
  if (route.kind !== 'tasks') throw new HttpError(404, 'Not found');
  const task = liveTask(store, route.id);
  if (route.action === 'report') return { report: renderReport(store, route.id) };
  if (route.action === 'check-output') {
    const query = parseRequest(checkOutputQuery, Object.fromEntries(url.searchParams));
    const check = store.check(query.checkId);
    if (store.execution(check.executionId).taskId !== task.id)
      throw new HttpError(404, 'Check belongs to another task');
    return readCheckLog(
      check,
      query.stream,
      query.offset,
      checkOutputLimits.maxPageCharacters,
      query.raw === '1',
    ) satisfies CheckOutputPage;
  }
  throw new HttpError(404, 'Not found');
}

function postRoot(dashboard: Dashboard, path: string, payload: unknown): [number, unknown] {
  const { kickoffs, tasks } = dashboard;
  switch (path) {
    case '/api/references/suggest':
      return [
        200,
        {
          suggestions: suggestReferenceFolders(parseRequest(suggestReferencesBody, payload).request ?? ''),
        } satisfies ReferenceSuggestionsResponse,
      ];
    case '/api/repositories/inspect': {
      const inspected = kickoffs.inspect(parseRequest(inspectRepositoryBody, payload));
      return [
        200,
        { repo: inspected.repo, base: inspected.base, context: inspected.context } satisfies InspectRepositoryResponse,
      ];
    }
    case '/api/repositories/files':
      return [200, kickoffs.search(parseRequest(searchFilesBody, payload)) satisfies FileSearchResponse];
    case '/api/kickoffs':
      return [201, { id: kickoffs.create(parseRequest(createKickoffBody, payload)) } satisfies CreatedResponse];
    case '/api/tasks':
      return [201, { id: tasks.create(parseRequest(createTaskBody, payload).plan).id } satisfies CreatedResponse];
    case '/api/settings': {
      if (dashboard.settingsDirectory === null)
        throw new HttpError(409, 'This dashboard was started without a settings file, so it cannot save one');
      const body = parseRequest(saveSettingsBody, payload);
      saveSettingsFile(dashboard.settingsDirectory, body.overrides, body.expected);
      return [200, { ok: true }];
    }
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
  if (action === 'pause') {
    new GuidedTasks(store, { expectedState: decided }).pause(id);
    return [200, { ok: true }];
  }
  if (action === 'guidance') {
    const body = parseRequest(queueGuidanceBody, payload);
    new GuidedTasks(store, { expectedState: decided }).queueGuidance(id, body.text, body.target);
    return [200, { ok: true }];
  }
  if (action === 'cancel-guidance') {
    const body = parseRequest(cancelGuidanceBody, payload);
    new GuidedTasks(store, { expectedState: decided }).cancelGuidance(id, body.messageId);
    return [200, { ok: true }];
  }
  if (action === 'approve') {
    const body = parseRequest(approveTaskBody, payload);
    const approved = new GuidedTasks(store, { expectedState: body.expected }).approve(id, body.version, body.digest);
    if (approved.plan.workflowPolicy.mode !== 'automatic') return [200, { ok: true }];
    // Approval stands even when the runner pool is full; the task waits as ready for an explicit Continue.
    const pool = runnerPool(store);
    if (pool.active >= pool.limit) return [200, { ok: true, started: false }];
    dashboard.launch(id, { action: 'run', payload: { expected: guidedDecisionKey(approved) } });
    return [202, { ok: true }];
  }
  if (!taskWorkerActions.some(name => name === action)) throw new HttpError(404, 'Unknown task action');
  const work = parseRequest(workerActionSchema, { action, payload });
  // Answer 409 at once; the worker's own claim stays authoritative if another task takes the slot first.
  if (pooledWorkerActions.includes(work.action)) assertRunnerAvailable(store);
  dashboard.launch(id, work);
  return [202, { ok: true }];
}

async function postItem(dashboard: Dashboard, route: ItemRoute, payload: unknown): Promise<[number, unknown]> {
  const { action, id, kind } = route;
  if (!action) throw new HttpError(404, 'Not found');
  if (kind === 'tasks' && action === 'open-orca') {
    liveTask(dashboard.store, id);
    parseRequest(z.strictObject({}), payload);
    if (!dashboard.orca) throw new HttpError(503, 'Orca navigation is unavailable in this dashboard');
    try {
      await dashboard.orca.open(id, `${dashboard.accessUrl()}!/tasks/${id}`);
    } catch {
      throw new HttpError(
        503,
        'Could not open the Orca workspace. Inspect its identity and local Orca runtime before trying again.',
      );
    }
    return [200, { ok: true, settled: true }];
  }
  if (dashboard.jobs.get(id)?.running && !['stop', 'pause', 'guidance', 'cancel-guidance'].includes(action))
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

/** Starts one action worker for `id` and tracks it in `jobs`; a failure is journaled once. */
function launchWorker(store: Store, jobs: Map<string, Job>, health: boolean, id: string, work: WorkerAction): void {
  if (jobs.get(id)?.running) throw new HttpError(409, 'An action is already running for this item');
  pruneJobs(jobs);
  const job: Job = {
    running: true,
    error: null,
    action: work.action,
    startedAt: new Date().toISOString(),
    settledAt: null,
  };
  jobs.set(id, job);
  let journaled = false;
  const failed = (failure: WorkerFailure, exitCode: number | null) => {
    job.error = failure.error;
    if (journaled) return;
    journaled = true;
    journalFailure(store, id, work, failure, exitCode);
  };
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
    job.settledAt ??= new Date().toISOString();
    if (!child.pid) failed({ error: error.message, reasonCode: null }, null);
    else job.error = error.message;
  });
  child.stdin.on('error', error => {
    job.error = error.message;
  });
  child.on('close', code => {
    job.running = false;
    job.settledAt = new Date().toISOString();
    if (code !== 0) failed(workerFailure(output, job.error ?? `Worker exited (${code})`), code);
  });
  child.stdin.end(
    JSON.stringify({ db: store.path, id, ...work, settings: currentSettings(), ...(health ? { health: true } : {}) }),
  );
}

/** Scan for stalls now and every `stallLimits.scanIntervalMs`; the timer never keeps the process alive. */
function watchStalls(stalls: StallWatchdog): ReturnType<typeof setInterval> {
  const scan = () => {
    try {
      stalls.scan();
    } catch {
      /* Detection is observational; the next scan tries again and the previous result stays shown. */
    }
  };
  scan();
  const timer = setInterval(scan, stallLimits.scanIntervalMs);
  timer.unref();
  return timer;
}

/** `GET /api/health`: the stored health, after running the checks again when `refresh=1`. */
async function healthRoute(dashboard: Dashboard, url: URL): Promise<unknown> {
  if (url.searchParams.get('refresh') === '1') {
    if (!dashboard.health)
      throw new HttpError(409, 'Health checks are not available in this dashboard; run grampus doctor');
    await dashboard.health.refresh();
  }
  return healthView(dashboard.store, dashboard.now());
}

/** Native desktop routes share the token and origin guard; shutdown responds before closing HTTP. */
async function desktopRoute(
  desktop: DesktopService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (request.method === 'GET' && path === '/api/desktop') {
    if (!desktop.endpoint) throw new HttpError(404, 'Desktop discovery is not configured');
    json(response, 200, desktopIdentity(desktop.endpoint));
    return true;
  }
  if (request.method === 'POST' && path === '/api/desktop/close') {
    const body = parseRequest(z.strictObject({ instance: z.string() }), await readBody(request));
    desktop.prepareClose(body.instance);
    response.once('finish', () => {
      void desktop.close().catch(() => console.error('Dashboard shutdown did not settle'));
    });
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}

/** Loopback dashboard. Workers use the same durable controller as the CLI. */
export async function startUi(options: UiOptions) {
  const store = new Store(options.db),
    tasks = new GuidedTasks(store),
    kickoffs = new Kickoffs(store);
  const token = randomBytes(32).toString('hex'),
    jobs = new Map<string, Job>();
  const client = options.client ?? defaultClientDirectory;
  let origin = '';
  const now = options.now ?? Date.now;
  const stalls = new StallWatchdog(store, now);
  const health = options.health ? new HealthMonitor(store, options.health, now) : null;
  const stallTimer = watchStalls(stalls);
  const launch = (id: string, work: WorkerAction) => launchWorker(store, jobs, health !== null, id, work);
  const settingsDirectory = options.settingsDirectory ?? null;
  const orca = options.orca ? new OrcaPresentation(store, options.orca) : null;
  const accessUrl = () => `${origin}/#${token}`;
  const desktop = new DesktopService(
    options.desktop ?? null,
    () => [...jobs.values()].some(job => job.running),
    async () => {
      clearInterval(stallTimer);
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      await health?.settled();
      await orca?.close();
      store.close();
    },
  );
  const dashboard: Dashboard = {
    store,
    tasks,
    kickoffs,
    jobs,
    launch,
    stalls,
    health,
    now,
    settingsDirectory,
    orca,
    accessUrl,
  };
  const apiV1 = createApiV1({ store, kickoffs, jobs, stalls, now, settingsDirectory, orca });
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    securityHeaders(response);
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      throw new HttpError(403, 'Local origin required');
    }
    const url = new URL(request.url ?? '/', origin);
    const path = url.pathname;
    if (request.method === 'GET' && !path.startsWith('/api/')) {
      serveClient(client, path, response);
      return;
    }
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
      throw new HttpError(401, 'Open the complete local dashboard link printed by Grampus');
    desktop.assertOpen();
    if (await desktopRoute(desktop, request, response, path)) return;
    const groups = itemRoute.exec(path)?.groups;
    const route = groups ? routeSchema.parse(groups) : null;
    if (request.method === 'GET') {
      if (path.startsWith('/api/v1/')) {
        pruneJobs(jobs);
        json(response, 200, await apiV1.get(path, url));
        return;
      }
      if (path === '/api/health') {
        json(response, 200, await healthRoute(dashboard, url));
        return;
      }
      if (!route) throw new HttpError(404, 'Not found');
      json(response, 200, getItem(dashboard, route, url));
      return;
    }
    if (request.method !== 'POST') throw new HttpError(404, 'Not found');
    const payload = await readBody(request);
    // Body delivery can span an accepted shutdown. Recheck before any mutation or worker dispatch.
    desktop.assertOpen();
    const [status, body] = route ? await postItem(dashboard, route, payload) : postRoot(dashboard, path, payload);
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
    origin = `http://127.0.0.1:${await listenForBrowsers(server, options.port ?? currentSettings().dashboardPort)}`;
    desktop.publish(accessUrl());
  } catch (error) {
    clearInterval(stallTimer);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    throw error;
  }
  // In the background: the dashboard is usable at once and shows the stored result until the check settles.
  void health?.refreshIfStale();
  orca?.start();
  return {
    server,
    store,
    url: accessUrl(),
    /** The private desktop receipt, when discovery was configured. */
    endpoint: desktop.endpoint,
    /** Display-only Orca reconciliation; tests can await a scan without advancing the workflow. */
    orca,
    /** Stall detection of this dashboard; tests call `scan` with an injected clock. */
    stalls,
    /** The action worker this dashboard last started for a task or planning conversation, if any. */
    job: (id: string): Readonly<Job> | null => jobs.get(id) ?? null,
    close: () => desktop.close(),
  };
}
