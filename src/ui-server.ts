import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { GuidedTasks, guidedDecisionKey } from './guided-tasks.js';
import { guidedTaskView } from './guided-status.js';
import { renderReport } from './report.js';
import { Kickoffs } from './kickoff.js';
import { boundedRepositoryFiles } from './repository-evidence.js';
import { editingScopeFiles } from './edit-policy.js';
import { Sessions } from './sessions.js';
import { defaultDashboardPort, versionInformation } from './runtime.js';
import { TaskLifecycle } from './task-lifecycle.js';
import { suggestReferenceFolders } from './reference-folders.js';
import type { Task } from './workflow.js';

interface Job { running: boolean; error: string | null; action: string }
export interface UiOptions { db: string; port?: number }

/** Loopback dashboard. Workers use the same durable controller as the CLI. */
export async function startUi(options: UiOptions) {
  const store = new Store(options.db), tasks = new GuidedTasks(store), kickoffs = new Kickoffs(store);
  const token = randomBytes(32).toString('hex'), jobs = new Map<string, Job>();
  let cachedState: { revision: string; value: unknown } | null = null;
  const cachedViews = new Map<string, { revision: string; value: unknown }>();
  let origin = '';
  const json = (response: ServerResponse, code: number, body: unknown) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
  };
  const launch = (id: string, action: string, payload: unknown) => {
    if (jobs.get(id)?.running) throw new Error('An action is already running for this item');
    const job: Job = { running: true, error: null, action }; jobs.set(id, job);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./ui-worker.js', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-16000); });
    child.on('error', error => { job.running = false; job.error = error.message; });
    child.stdin.on('error', error => { job.error = error.message; });
    child.on('close', code => { job.running = false; if (code !== 0) job.error = output.trim() || job.error || `Worker exited (${code})`; });
    child.stdin.end(JSON.stringify({ db: store.path, id, action, payload }));
  };
  async function body(request: IncomingMessage): Promise<Record<string, any>> {
    if (request.headers['content-type'] !== 'application/json') throw new Error('Use application/json');
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
    return value as Record<string, any>;
  }
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { json(response, 403, { error: 'Local origin required' }); return; }
      const path = new URL(request.url ?? '/', origin).pathname;
      const assets: Record<string, [string, string]> = {
        '/': ['src/ui/index.html', 'text/html'], '/app.js': ['src/ui/app.js', 'text/javascript'],
        '/app.css': ['src/ui/app.css', 'text/css'], '/favicon.svg': ['src/ui/favicon.svg', 'image/svg+xml'],
        '/markdown.js': ['src/ui/markdown.js', 'text/javascript'],
        '/vendor/markdown-it.js': ['node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'text/javascript'],
      };
      if (request.method === 'GET' && assets[path]) {
        const [file, mime] = assets[path]!;
        response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        response.end(readFileSync(new URL(`../../${file}`, import.meta.url))); return;
      }
      const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { json(response, 401, { error: 'Open the complete local dashboard link printed by Grampus' }); return; }
      if (request.method === 'GET' && path === '/api/state') {
        const revision = store.revision();
        if (cachedState?.revision !== revision) cachedState = { revision, value: { tasks: store.guidedSummaries(), kickoffs: kickoffs.list() } };
        json(response, 200, { ...cachedState.value as object, jobs: Object.fromEntries(jobs), journal: store.path, application: versionInformation() }); return;
      }
      const match = /^\/api\/(tasks|kickoffs)\/([a-f0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
      if (match && request.method === 'GET' && match[1] === 'tasks' && match[3] === 'report') {
        if (store.get<Task>(match[2]!).deletedAt) throw new Error('This task was deleted');
        json(response, 200, { report: renderReport(store, match[2]!) }); return;
      }
      if (match && request.method === 'GET' && match[1] === 'tasks' && !match[3]) {
        if (store.get<Task>(match[2]!).deletedAt) throw new Error('This task was deleted');
        const revision = store.revision(), cached = cachedViews.get(match[2]!);
        if (cached?.revision === revision) { json(response, 200, cached.value); return; }
        const view = guidedTaskView(store, match[2]!);
        let scopeFiles: { path: string; content: string | null }[] = [], scopeError: string | null = null;
        if (view.state.status === 'awaiting_scope' && view.workspace?.path && view.state.snapshot) {
          try {
            const slice = view.state.plan.slices[view.state.sliceIndex]!;
            const selection = [...new Set([...(view.state.policy?.files ?? slice.scope.files), ...(slice.scope.delete ?? [])])];
            const current = { ...view.state.snapshot, diff: view.state.snapshot.diff.filter(change => selection.includes(change.path)) };
            scopeFiles = view.state.policy ? editingScopeFiles({ cwd: view.workspace.path, snapshot: current, policy: view.state.policy })
              : boundedRepositoryFiles(view.workspace.path, current, selection);
          }
          catch (error) { scopeError = error instanceof Error ? error.message : String(error); }
        }
        // Never serialize the full hashed file inventory, delivery snapshot or report on a poll.
        const compactState = { ...view.state, snapshot: view.state.snapshot ? { ...view.state.snapshot, files: [], index: '', totalFiles: view.state.snapshot.files.length } : null };
        const value = { ...view, state: compactState, task: { ...view.task, guided: compactState },
          implementations: view.implementations.map(run => ({ id: run.id, phase: run.phase, error: run.error })),
          deliveries: view.deliveries.map(delivery => ({ ...delivery, request: null })),
          scopeFiles, scopeError, events: store.events(match[2]!).slice(-30).map(event => ({ ...event, data: { note: (event.data as { note?: string })?.note } })), report: null };
        if (cachedViews.size >= 4) cachedViews.delete(cachedViews.keys().next().value!);
        cachedViews.set(match[2]!, { revision, value });
        json(response, 200, value); return;
      }
      if (request.method !== 'POST') { json(response, 404, { error: 'Not found' }); return; }
      const payload = await body(request);
      if (path === '/api/references/suggest') { json(response, 200, { suggestions: suggestReferenceFolders(String(payload.request ?? '')) }); return; }
      if (path === '/api/repositories/inspect') {
        const inspected = kickoffs.inspect(payload as Parameters<Kickoffs['inspect']>[0]);
        json(response, 200, { repo: inspected.repo, base: inspected.base, context: inspected.context }); return;
      }
      if (path === '/api/repositories/files') { json(response, 200, kickoffs.search(payload as Parameters<Kickoffs['search']>[0])); return; }
      if (path === '/api/kickoffs') { const id = kickoffs.create(payload as Parameters<Kickoffs['create']>[0]); json(response, 201, { id }); return; }
      if (path === '/api/tasks') { const task = tasks.create(payload.plan); json(response, 201, { id: task.id }); return; }
      if (!match || !match[3]) { json(response, 404, { error: 'Not found' }); return; }
      const [, kind, id, action] = match;
      if (jobs.get(id!)?.running && action !== 'stop') throw new Error('An action is already running; wait for settlement');
      if (action === 'delete' || action === 'reset') {
        const lifecycle = new TaskLifecycle(store);
        const result = action === 'delete' ? lifecycle.delete(kind as 'tasks' | 'kickoffs', id!, payload.expected) : lifecycle.reset(kind as 'tasks' | 'kickoffs', id!, payload.expected);
        json(response, 200, result); return;
      }
      if (kind === 'kickoffs') {
        const view = kickoffs.view(id!);
        if (action === 'context') { json(response, 200, kickoffs.changeContext(id!, payload.files, payload.expected)); return; }
        if (action === 'references') { json(response, 200, kickoffs.changeContext(id!, view.config.files, payload.expected, payload.references)); return; }
        if (action === 'stop') {
          if (!view.session.run) throw new Error('Planner has not started or has already settled; refresh its state');
          new Sessions(store).stop(id!, view.session.run.id, 'User requested a stop in the dashboard');
          json(response, 200, { ok: true }); return;
        }
        if (action === 'prepare') {
          if (typeof payload.digest !== 'string') throw new Error('Preparing approval requires the displayed proposal digest');
          json(response, 201, { id: kickoffs.prepare(id!, payload.digest) }); return;
        }
        if (action !== 'plan' && action !== 'planner-recover') throw new Error('Unknown kickoff action');
        if (action === 'plan' && payload.expected !== view.turnKey) throw new Error('Planning state changed; inspect the current discussion');
        launch(id!, action, payload);
      } else {
        const view = guidedTaskView(store, id!);
        if (action === 'stop') { tasks.stop(id!); json(response, 200, { ok: true }); return; }
        // Every decision names the exact state displayed to the user. A stale tab cannot authorize new bytes.
        const expected = guidedDecisionKey(view.state, view.questionKey);
        if (payload.expected !== expected) throw new Error('Task changed since you inspected it; refresh before taking this action');
        if (action === 'approve') { new GuidedTasks(store, { expectedState: payload.expected }).approve(id!, payload.version, payload.digest); json(response, 200, { ok: true }); return; }
        if (!['run', 'authorize', 'assess', 'answer', 'retry', 'revise', 'recover', 'release-workspace'].includes(action!)) throw new Error('Unknown task action');
        launch(id!, action!, payload);
      }
      json(response, 202, { ok: true });
    })().catch(error => { if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : String(error) }); else response.end(); });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? defaultDashboardPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { store.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, store, url: `${origin}/#${token}`, close: async () => {
    if ([...jobs.values()].some(job => job.running)) throw new Error('An action is still running; stop it and wait for settlement before closing');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close();
  } };
}
