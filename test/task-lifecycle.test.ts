import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { TaskLifecycle } from '../src/orchestration/task-lifecycle.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-lifecycle-')),
    repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'entry.js'), "console.log('hello');\n");
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const db = join(root, 'grampus.sqlite'),
    store = new Store(db),
    tasks = new GuidedTasks(store),
    planners = new Kickoffs(store),
    lifecycle = new TaskLifecycle(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = {
    workflowPolicy: { mode: 'supervised' },
    brief: { title: 'Verify greeting', outcome: 'Print hello', criteria: ['Print hello'], plan: 'Verify greeting' },
    workspace: { repo, path: join(root, 'workspace') },
    context: { files: [] },
    slices: [
      {
        scope: { files: ['entry.js'] },
        validation: { file: 'node', args: ['--check', 'entry.js'] },
        acceptance: { file: 'node', args: ['entry.js'], expectedStdout: 'hello\n' },
        message: 'Greeting',
      },
    ],
  };
  return { root, repo, git, db, store, tasks, planners, lifecycle, plan };
}

test('deleting a settled planning conversation removes it durably and rejects stale or active actions', t => {
  const f = fixture(t),
    id = f.planners.create({ repo: f.repo, request: 'Implement the original request' });
  const initial = f.planners.view(id);
  assert.throws(() => f.lifecycle.delete('kickoffs', id, 'stale'), /changed/);
  const session = f.store.session(id);
  session.run = {
    id: 'fixture-run',
    controllerPid: process.pid,
    controllerStartedAt: null,
    providerPid: null,
    providerStartedAt: null,
    host: 'fixture',
  };
  session.phase = 'recovery_required';
  f.store.saveSession(id, session);
  assert.throws(() => f.lifecycle.delete('kickoffs', id, f.planners.view(id).turnKey), /settlement/);
  session.run = null;
  session.phase = 'idle';
  f.store.saveSession(id, session);
  f.lifecycle.delete('kickoffs', id, f.planners.view(id).turnKey);
  assert.deepEqual(f.planners.list(), []);
  assert.throws(() => f.planners.view(id), /deleted/);
  const reopened = new Store(f.db);
  try {
    assert.deepEqual(new Kickoffs(reopened).list(), []);
    assert.ok(reopened.session(id).deletedAt);
  } finally {
    reopened.close();
  }
  assert.equal(existsSync(join(f.repo, 'entry.js')), true);
  assert.ok(initial.config.request);
});

test('resetting planning retains the request and starts a fresh conversation', t => {
  const f = fixture(t),
    id = f.planners.create({ repo: f.repo, request: 'Exact original request', provider: 'claude' });
  const previousPath = f.planners.view(id).config.path;
  writeFileSync(join(f.repo, 'entry.js'), "console.log('new baseline');\n");
  f.git('add', '.');
  f.git('commit', '-m', 'New baseline');
  const result = f.lifecycle.reset('kickoffs', id, f.planners.view(id).turnKey),
    fresh = f.planners.view(result.id);
  assert.notEqual(result.id, id);
  assert.equal(fresh.config.request, 'Exact original request');
  assert.equal(fresh.config.provider, 'claude');
  assert.equal(fresh.session.providerSessionId, null);
  assert.deepEqual(fresh.messages, []);
  assert.notEqual(fresh.config.path, previousPath);
  assert.equal(fresh.config.base, f.git('rev-parse', 'HEAD'));
  assert.equal(f.planners.list().length, 1);
  assert.equal(f.store.workspaces().length, 0);
});

test('delete/reset at a file checkpoint preserve the worktree and journal, revoke old execution and require new approval', async t => {
  const f = fixture(t),
    task = f.tasks.create(f.plan);
  const draft = f.tasks.get(task.id);
  f.tasks.approve(task.id, draft.version, draft.digest);
  await f.tasks.run(task.id);
  const scope = f.tasks.get(task.id);
  assert.equal(scope.status, 'awaiting_scope');
  writeFileSync(join(f.plan.workspace.path, 'retained.txt'), 'User work is preserved');
  const before = f.git('rev-parse', 'HEAD');
  assert.throws(() => f.lifecycle.reset('tasks', task.id, 'stale'), /changed/);
  const result = f.lifecycle.reset('tasks', task.id, guidedDecisionKey(scope));
  assert.equal(f.planners.view(result.id).session.providerSessionId, null);
  assert.equal(existsSync(join(f.plan.workspace.path, 'retained.txt')), true);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.store.get(task.id).approvedVersion, null);
  assert.ok(f.store.get(task.id).deletedAt);
  assert.equal(f.store.guidedSummaries().length, 0);
  assert.ok(f.store.events(task.id).some(event => event.type === 'task.reset'));
  await assert.rejects(f.tasks.authorize(task.id), /deleted/);
});

test('management refuses a live controller or uncertain workspace and rolls back reset failures', t => {
  const f = fixture(t),
    task = f.tasks.create(f.plan),
    saved = f.store.get(task.id);
  saved.guided!.owner = { token: 'fixture', host: 'fixture', controllerPid: process.pid, controllerStartedAt: null };
  f.store.save(task.id, saved);
  assert.throws(() => f.lifecycle.delete('tasks', task.id, guidedDecisionKey(saved.guided!)), /settlement/);
  saved.guided!.owner = null;
  f.store.save(task.id, saved);
  const id = f.planners.create({ repo: f.repo, request: 'Original' });
  // A reset failure must not hide the original item or leave a new partial conversation.
  const failing = t.mock.method(Kickoffs.prototype, 'create', () => {
    throw new Error('Source unavailable');
  });
  try {
    assert.throws(() => f.lifecycle.reset('kickoffs', id, f.planners.view(id).turnKey), /Source unavailable/);
  } finally {
    failing.mock.restore();
  }
  assert.equal(f.store.session(id).deletedAt, undefined);
  assert.equal(f.planners.view(id).config.request, 'Original');
});
