// The dashboard server over real HTTP: task views, queued commands, live changes, and the guards that keep
// other web pages from driving it through a visitor's browser.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { usageText, commands } from '../src/commands.js';
import { serveDashboard, type RunningDashboard } from '../src/dashboard/server.js';
import type { ChangesView, DiffView, HealthView, TaskDetail, TaskList } from '../src/dashboard/types.js';
import { standardRecipe } from '../src/domain/recipe.js';
import { git, headSha } from '../src/git/git.js';
import { TaskStore } from '../src/store/task-store.js';
import { FakeOrca } from './helpers/fake-orca.js';
import { commitAll, createRepository, useTestSettings, write } from './helpers/task-fixture.js';

const running: RunningDashboard[] = [];
after(async () => {
  for (const server of running) await server.close();
});

interface Fixture {
  home: string;
  store: TaskStore;
  base: string;
  port: number;
  specPath: string;
  orca: FakeOrca;
}

async function start(): Promise<Fixture> {
  useTestSettings({ waitPollMs: 20 });
  const home = mkdtempSync(join(tmpdir(), 'grampus-dashboard-'));
  const web = join(home, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Grampus</title>');
  writeFileSync(join(web, 'assets', 'app-1.js'), 'console.log(1)');
  writeFileSync(join(home, 'secret.txt'), 'not for the dashboard');
  const store = TaskStore.create(home, 'task-1');
  store.append({
    type: 'task.created',
    taskId: 'task-1',
    title: 'Greet',
    request: 'Say **hello**',
    repoPath: home,
    recipe: standardRecipe,
  });
  const specPath = join(home, 'spec-v1.md');
  writeFileSync(specPath, '# Greet\n');
  store.append({
    type: 'spec.recorded',
    key: 'spec:1',
    version: 1,
    hash: 'h',
    path: specPath,
    checks: [{ name: 'greet', command: 'node test.js' }],
    protected: [],
  });
  store.append({
    type: 'attention.needed',
    reason: 'approve-spec:1',
    detail: 'Approve spec version 1',
    options: ['approve', 'revise'],
  });
  const orca = new FakeOrca(() => 'hang');
  const server = await serveDashboard({
    dataDir: home,
    port: 0,
    selfCommand: 'grampus',
    webRoot: web,
    orca,
  });
  running.push(server);
  return { home, store, base: `http://localhost:${server.port}`, port: server.port, specPath, orca };
}

/** A raw request, so tests can set the Host and Origin headers a browser would send. */
function raw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${port}`, ...options.headers },
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    call.on('error', reject);
    call.end(options.body);
  });
}

test('lists tasks and shows one with its pipeline, pending decision and timeline', async () => {
  const { base } = await start();
  const list = (await (await fetch(`${base}/api/tasks`)).json()) as TaskList;
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0]?.status, 'needs-you');
  assert.equal(list.tasks[0]?.needsYou?.reason, 'approve-spec:1');

  const detail = (await (await fetch(`${base}/api/tasks/task-1`)).json()) as TaskDetail;
  assert.equal(detail.request, 'Say **hello**');
  assert.equal(detail.pipeline.find(step => step.id === 'approve')?.state, 'waiting');
  assert.equal(detail.pipeline.find(step => step.id === 'spec')?.state, 'done');
  assert.equal(detail.specs[0]?.text, '# Greet\n');
  assert.ok(detail.timeline.some(item => item.title === 'Spec v1 recorded'));
  assert.equal(detail.summary.approval?.version, 1, 'the approval request carries the spec');
});

test('system health lists each unfinished task with its driver, and Orca as checked', async () => {
  const { base, orca } = await start();
  const health = (await (await fetch(`${base}/api/health`)).json()) as HealthView;
  assert.deepEqual(
    health.drivers.map(driver => [driver.id, driver.state]),
    [['task-1', 'starting']],
    'no driver has taken the lock yet, and it is too early to call it missing',
  );
  assert.equal(health.orca.ok, true);
  assert.equal(health.orca.version, 'fake-1.0');
  assert.equal(health.level, 'ok');
  await fetch(`${base}/api/health`);
  assert.equal(orca.healthChecks, 1, 'Orca is checked once per probe interval, not per request');
});

test('an unknown task is a 404, not a crash', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/api/tasks/missing-task`)).status, 404);
});

test('a decision from the dashboard is queued for the driver with source dashboard', async () => {
  const { base, port, store } = await start();
  const response = await raw(port, '/api/tasks/task-1/commands', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'approve', specVersion: 1 }),
  });
  assert.equal(response.status, 202, response.body);
  const [command] = store.commands();
  assert.equal(command?.kind, 'approve');
  assert.equal(command?.source, 'dashboard');

  const detail = (await (await fetch(`${base}/api/tasks/task-1`)).json()) as TaskDetail;
  assert.equal(detail.commands[0]?.state, 'queued', 'a command the driver has not applied shows as queued');
});

test('an invalid command is refused with the reason', async () => {
  const { base, port, store } = await start();
  const response = await raw(port, '/api/tasks/task-1/commands', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'approve' }),
  });
  assert.equal(response.status, 400);
  assert.match(response.body, /specVersion/);
  assert.equal(store.commands().length, 0);
});

test('writes from another origin, without an origin or not as JSON are refused', async () => {
  const { base, port, store } = await start();
  const body = JSON.stringify({ kind: 'accept' });
  const json = { 'Content-Type': 'application/json' };
  const crossSite = await raw(port, '/api/tasks/task-1/commands', {
    method: 'POST',
    headers: { ...json, Origin: 'https://evil.example' },
    body,
  });
  assert.equal(crossSite.status, 403);
  const noOrigin = await raw(port, '/api/tasks/task-1/commands', { method: 'POST', headers: json, body });
  assert.equal(noOrigin.status, 403);
  const form = await raw(port, '/api/tasks/task-1/commands', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'text/plain' },
    body,
  });
  assert.equal(form.status, 415, 'a simple cross-site form post cannot send JSON');
  assert.equal(store.commands().length, 0);
});

test('requests for a host this machine does not answer to are refused (DNS rebinding)', async () => {
  const { port } = await start();
  const rebound = await raw(port, '/api/tasks', { headers: { Host: `evil.example:${port}` } });
  assert.equal(rebound.status, 421);
  assert.equal((await raw(port, '/api/tasks', { headers: { Host: `127.0.0.1:${port}` } })).status, 200);
});

test('serves only files the task log records', async () => {
  const { base, home, specPath } = await start();
  const spec = await fetch(`${base}/api/tasks/task-1/file?path=${encodeURIComponent(specPath)}`);
  assert.equal(spec.status, 200);
  assert.equal(await spec.text(), '# Greet\n');
  const other = await fetch(`${base}/api/tasks/task-1/file?path=${encodeURIComponent(join(home, 'secret.txt'))}`);
  assert.equal(other.status, 404);
});

test('serves the web app with client routes falling back to index.html, and never outside it', async () => {
  const { base, port } = await start();
  const page = await fetch(`${base}/tasks/task-1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Grampus/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY', 'pages cannot be framed');
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const asset = await fetch(`${base}/assets/app-1.js`);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  const escape = await raw(port, '/..%2Fsecret.txt');
  assert.doesNotMatch(escape.body, /not for the dashboard/);
});

test('live clients hear which task changed', async () => {
  const { base, store } = await start();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/live`, { signal: controller.signal });
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let received = '';
  const until = async (pattern: RegExp) => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${pattern}`);
      received += value;
    }
  };
  await until(/event: hello/);
  store.append({ type: 'driver.stopped', reason: 'test' });
  await until(/event: change\ndata: \{[^\n]*"tasks":\["task-1"\]/);
  controller.abort();
});

test('the help catalog lists every command the CLI prints', async () => {
  const { base } = await start();
  const help = (await (await fetch(`${base}/api/help`)).json()) as { groups: { commands: { name: string }[] }[] };
  const names = help.groups.flatMap(group => group.commands.map(command => command.name));
  assert.deepEqual(names.sort(), commands.map(command => command.name).sort());
  for (const name of names) assert.match(usageText(), new RegExp(`^  ${name}\\b`, 'm'));
});

test('a provisional scorecard is measured for a running task', async () => {
  const { base } = await start();
  const card = (await (await fetch(`${base}/api/tasks/task-1/scorecard`)).json()) as {
    final: boolean;
    outcome: string;
  };
  assert.equal(card.final, false);
  assert.equal(card.outcome, 'running');
});

test("the task's changes so far are counted per file and served as a diff, cut at the configured size", async () => {
  const { home, base } = await start();
  const repo = await createRepository();
  const baseSha = await headSha(repo);
  const store = TaskStore.create(home, 'task-2');
  store.append({
    type: 'task.created',
    taskId: 'task-2',
    title: 'T',
    request: 'R',
    repoPath: repo,
    recipe: standardRecipe,
  });
  store.append({ type: 'workspace.created', worktreeId: 'wt', path: repo, baseSha, driverTerminal: 'term' });
  write(repo, 'greet.js', 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  write(repo, 'docs/notes.md', 'one\ntwo\n');
  await git(repo, ['mv', 'package.json', 'package.json.bak']);
  await commitAll(repo, 'Greet by name');
  const sha = await headSha(repo);

  const changes = (await (await fetch(`${base}/api/tasks/task-2/changes`)).json()) as ChangesView;
  assert.equal(changes.baseSha, baseSha);
  assert.equal(changes.sha, sha);
  const byPath = new Map(changes.files.map(file => [file.path, file]));
  assert.deepEqual(byPath.get('greet.js'), { path: 'greet.js', oldPath: null, added: 1, deleted: 1 });
  assert.deepEqual(byPath.get('docs/notes.md'), { path: 'docs/notes.md', oldPath: null, added: 2, deleted: 0 });
  assert.equal(byPath.get('package.json.bak')?.oldPath, 'package.json', 'a rename names the old path');

  const diff = (await (await fetch(`${base}/api/tasks/task-2/diff`)).json()) as DiffView;
  assert.equal(diff.truncated, false);
  assert.match(diff.patch, /^\+ {2}return `Hello, \$\{name\}!`;$/m);

  useTestSettings({ waitPollMs: 20, dashboardDiffBytes: 40 });
  const cut = (await (await fetch(`${base}/api/tasks/task-2/diff`)).json()) as DiffView;
  assert.equal(cut.truncated, true);
  assert.equal(cut.patch.length, 40);
  const file = (await (await fetch(`${base}/api/tasks/task-2/diff?path=greet.js`)).json()) as DiffView;
  assert.equal(file.truncated, false, 'a file request never silently cuts the patch');
  assert.match(file.patch, /Hello, \$\{name\}!/);
  assert.equal((await fetch(`${base}/api/tasks/task-2/diff?path=secret.txt`)).status, 404);
});

test('a task without a worktree has no changes to show', async () => {
  const { base } = await start();
  const response = await fetch(`${base}/api/tasks/task-1/changes`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /no worktree/);
});
