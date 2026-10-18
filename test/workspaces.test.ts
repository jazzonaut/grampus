import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { Workflow } from '../src/domain/workflow.js';
import { Workspaces, type Workspace } from '../src/repository/workspaces.js';
import { currentProcessStartedAt } from '../src/process/process-identity.js';
import { snapshotRepository } from '../src/repository/artifacts.js';

const brief = {
  title: 'Greeting',
  outcome: 'Print a greeting',
  criteria: ['Print hello'],
  plan: 'Add a command and check its output',
};
const agent = { provider: 'fixture', model: 'fixture', sessionId: 'fixture' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-workspace-test-'));
  const repo = join(root, 'source repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture baseline');
  const db = join(root, 'journal.sqlite');
  const store = new Store(db);
  const workflow = new Workflow(store);
  const task = workflow.create(brief);
  workflow.approve(task.id, task.version);
  const workspaces = new Workspaces(store);
  const destination = join(root, 'task workspace');
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, db, store, workflow, task, workspaces, destination };
}

function save(store: Store, workspace: Workspace): void {
  assert.ok(workspace.path);
  const path = workspace.path;
  store.transaction(() =>
    store.saveWorkspace(
      workspace.id,
      workspace.taskId,
      process.platform === 'win32' ? path.toLowerCase() : path,
      workspace,
    ),
  );
}

test('creates a locked worktree at the recorded base without touching dirty source changes', async t => {
  const { repo, db, store, task, workspaces, destination } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'greeting.txt'), 'local edits\n');
  writeFileSync(join(repo, 'untracked.txt'), 'keep me');
  const before = git(repo, 'status', '--porcelain');
  const created = await workspaces.create(task.id, 1, repo, destination);
  assert.equal(created.baseCommit, base);
  assert.equal(created.phase, 'ready');
  assert.equal(created.owner, null);
  assert.equal(git(repo, 'status', '--porcelain'), before);
  assert.equal(readFileSync(join(repo, 'greeting.txt'), 'utf8'), 'local edits\n');
  assert.equal(readFileSync(join(destination, 'greeting.txt'), 'utf8'), 'hello\n');
  assert.equal(git(destination, 'branch', '--show-current'), created.branch);
  assert.ok(store.workspaceEvents(created.id).some(item => item.type === 'workspace.requested'));
  assert.deepEqual(
    store.workspaceEvents(created.id).map(item => item.type),
    ['workspace.requested', 'git.started', 'git.exited', 'workspace.ready'],
  );
  const reopened = new Store(db);
  try {
    const inspection = await new Workspaces(reopened).inspect(created.id);
    assert.equal(inspection.head, base);
    assert.equal(inspection.dirty, false);
    assert.equal(inspection.taskCurrent, true);
  } finally {
    reopened.close();
  }
});

test('isolated checkout avoids automatic CRLF conversion without changing repository configuration', async t => {
  const f = fixture(t);
  git(f.repo, 'config', 'core.autocrlf', 'true');
  const created = await f.workspaces.create(f.task.id, 1, f.repo, f.destination);
  assert.equal(readFileSync(join(f.destination, 'greeting.txt'), 'utf8'), 'hello\n');
  assert.equal(git(f.repo, 'config', '--get', 'core.autocrlf'), 'true');
  assert.deepEqual((await snapshotRepository(f.destination, created.baseCommit)).diff, []);
});

test('explicit repository checkout attributes remain effective', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.gitattributes'), 'greeting.txt text eol=crlf\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Explicit CRLF attribute');
  const created = await f.workspaces.create(f.task.id, 1, f.repo, f.destination);
  assert.equal(readFileSync(join(f.destination, 'greeting.txt'), 'utf8'), 'hello\r\n');
  assert.ok(
    (await snapshotRepository(f.destination, created.baseCommit)).diff.some(file => file.path === 'greeting.txt'),
  );
});

test('approval, exact version and a real task are required before any Git mutation', async t => {
  const { repo, store, workflow, task, workspaces, destination } = fixture(t);
  await assert.rejects(workspaces.create(task.id, 2, repo, destination), /exact approved/);
  const draft = workflow.create(brief);
  await assert.rejects(workspaces.create(draft.id, 1, repo, destination), /exact approved/);
  const synthetic = workflow.create(brief, true);
  workflow.approve(synthetic.id, 1);
  await assert.rejects(workspaces.create(synthetic.id, 1, repo, destination), /Synthetic/);
  assert.equal(store.workspaces().length, 0);
  assert.equal(existsSync(destination), false);
  assert.equal(git(repo, 'branch', '--list').trim(), '* main');
});

test('refuses existing destinations, nested worktrees and invalid base references', async t => {
  const { repo, task, workspaces, destination } = fixture(t);
  await assert.rejects(workspaces.create(task.id, 1, repo, repo), /must not exist/);
  await assert.rejects(workspaces.create(task.id, 1, repo, join(repo, 'nested')), /outside existing/);
  await assert.rejects(workspaces.create(task.id, 1, repo, destination, '--bad-ref'), /Git rev-parse failed/);
  assert.equal(workspaces.list().length, 0);
  assert.equal(existsSync(destination), false);
});

test('two controllers cannot reserve the same task and a moving base is pinned to a commit', async t => {
  const { root, repo, db, task, workspaces, destination } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'greeting.txt'), 'new baseline\n');
  git(repo, 'commit', '-am', 'Move main');
  const secondStore = new Store(db);
  try {
    const results = await Promise.allSettled([
      workspaces.create(task.id, 1, repo, destination, base),
      new Workspaces(secondStore).create(task.id, 1, repo, join(root, 'other workspace'), base),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(workspaces.list().length, 1);
    const created = workspaces.list()[0]!;
    assert.ok(created.path);
    assert.equal((await workspaces.inspect(created.id)).head, base);
    assert.equal(readFileSync(join(created.path, 'greeting.txt'), 'utf8'), 'hello\n');
  } finally {
    secondStore.close();
  }
});

test('a proved-unused failed reservation can be released and explicitly recreated without deleting its old branch', async t => {
  const f = fixture(t),
    branch = `grampus/${f.task.id}`,
    base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'branch', branch);
  await assert.rejects(f.workspaces.create(f.task.id, 1, f.repo, f.destination), /needs recovery/);
  const failed = f.workspaces.list()[0]!;
  const released = await f.workspaces.release(failed.id);
  assert.equal(released.phase, 'released');
  assert.equal(existsSync(f.destination), false);
  assert.equal(git(f.repo, 'rev-parse', branch), base);
  const created = await f.workspaces.create(f.task.id, 1, f.repo, f.destination);
  assert.equal(created.id, failed.id);
  assert.equal(created.phase, 'ready');
  assert.notEqual(created.branch, branch);
  assert.equal(git(f.repo, 'rev-parse', branch), base);
  assert.ok(f.store.workspaceEvents(created.id).some(event => event.type === 'workspace.released'));
  await assert.rejects(f.workspaces.release(created.id), /unused standalone/);
});

test('reservation release refuses existing files and missing Git exit proof', async t => {
  const f = fixture(t);
  git(f.repo, 'branch', `grampus/${f.task.id}`);
  await assert.rejects(f.workspaces.create(f.task.id, 1, f.repo, f.destination), /needs recovery/);
  const failed = f.workspaces.list()[0]!;
  failed.owner!.exitConfirmed = false;
  f.store.saveWorkspace(failed.id, f.task.id, f.destination.toLowerCase(), failed);
  await assert.rejects(f.workspaces.release(failed.id), /confirmed Git exit/);
  failed.owner!.exitConfirmed = true;
  f.store.saveWorkspace(failed.id, f.task.id, f.destination.toLowerCase(), failed);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'keep.txt'), 'preserved');
  await assert.rejects(f.workspaces.release(failed.id), /files or Git registration exist/);
  assert.equal(readFileSync(join(f.destination, 'keep.txt'), 'utf8'), 'preserved');
  assert.equal(f.workspaces.get(failed.id).phase, 'recovery_required');
});

test(
  'creation recovery distinguishes a restarted controller with the exact same recycled Windows PID',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t),
      created = await f.workspaces.create(f.task.id, 1, f.repo, f.destination);
    created.phase = 'creating';
    created.owner = {
      controllerPid: process.pid,
      controllerStartedAt: currentProcessStartedAt(),
      gitPid: null,
      exitConfirmed: true,
    };
    f.store.saveWorkspace(created.id, f.task.id, f.destination.toLowerCase(), created);
    await assert.rejects(f.workspaces.recover(created.id), /still owned by this controller/);
    created.owner.controllerStartedAt = (BigInt(currentProcessStartedAt()!) - 1n).toString();
    f.store.saveWorkspace(created.id, f.task.id, f.destination.toLowerCase(), created);
    const recovered = await f.workspaces.recover(created.id);
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.owner, null);
    assert.equal(git(f.destination, 'rev-parse', 'HEAD'), created.baseCommit);
  },
);

test('Git failure retains its reservation and prevents automatic replay or task revision', async t => {
  const { root, repo, store, workflow, task, workspaces, destination } = fixture(t);
  git(repo, 'branch', `grampus/${task.id}`);
  await assert.rejects(workspaces.create(task.id, 1, repo, destination), /needs recovery/);
  const failed = workspaces.list()[0]!;
  assert.equal(failed.phase, 'recovery_required');
  assert.equal(failed.owner?.exitConfirmed, true);
  assert.equal(existsSync(destination), false);
  await assert.rejects(workspaces.create(task.id, 1, repo, join(root, 'retry')), /reservation/);
  assert.throws(() => workflow.revise(task.id, 1, brief), /workspace creation/);
  assert.throws(() => workflow.start(task.id, agent), /workspace creation/);
  await assert.rejects(workspaces.recover(failed.id), /registration/);
  assert.equal(workspaces.get(failed.id).phase, 'recovery_required');
  assert.ok(store.workspaceEvents(failed.id).some(item => item.type === 'git.exited'));
});

test('recovery adopts a verified completed checkout after a lost controller response without replay', async t => {
  const { repo, store, task, workspaces, destination } = fixture(t);
  const created = await workspaces.create(task.id, 1, repo, destination);
  // Simulate the persisted state immediately after Git exited, before ready was committed.
  created.phase = 'recovery_required';
  created.owner = { controllerPid: process.pid, gitPid: null, exitConfirmed: true };
  save(store, created);
  const recovered = await workspaces.recover(created.id);
  assert.equal(recovered.phase, 'ready');
  assert.equal(recovered.owner, null);
  assert.equal(store.workspaceEvents(created.id).filter(item => item.type === 'git.started').length, 1);
  assert.deepEqual(store.workspaceEvents(created.id).at(-1)?.data, { replayed: false });
});

test('a real controller crash before the ready transaction commits can be reconciled after restart', async t => {
  const { repo, db, store, task, workspaces, destination } = fixture(t);
  const storeUrl = new URL('../src/persistence/store.js', import.meta.url).href;
  const workspacesUrl = new URL('../src/repository/workspaces.js', import.meta.url).href;
  const script = `
    const { Store } = await import(process.argv[1]);
    const { Workspaces } = await import(process.argv[2]);
    const store = new Store(process.argv[3]);
    const append = store.appendWorkspace.bind(store);
    store.appendWorkspace = (id, type, data) => {
      if (type === 'workspace.ready') process.exit(0);
      append(id, type, data);
    };
    await new Workspaces(store).create(process.argv[4], 1, process.argv[5], process.argv[6]);
    process.exit(2);
  `;
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, storeUrl, workspacesUrl, db, task.id, repo, destination],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const interrupted = workspaces.list()[0]!;
  assert.equal(interrupted.phase, 'creating');
  assert.equal(interrupted.owner?.exitConfirmed, true);
  assert.notEqual(interrupted.owner?.controllerPid, process.pid);
  assert.equal(store.workspaceEvents(interrupted.id).at(-1)?.type, 'git.exited');
  assert.equal((await workspaces.recover(interrupted.id)).phase, 'ready');
  assert.equal(store.workspaceEvents(interrupted.id).filter(item => item.type === 'git.started').length, 1);
});

test('recovery blocks unknown or live Git, another host, and a live controller', async t => {
  const { repo, store, task, workspaces, destination } = fixture(t);
  const created = await workspaces.create(task.id, 1, repo, destination);
  created.phase = 'recovery_required';
  created.owner = { controllerPid: process.pid, gitPid: null, exitConfirmed: false };
  save(store, created);
  await assert.rejects(workspaces.recover(created.id), /Git exit is unconfirmed/);
  created.owner.gitPid = process.pid;
  save(store, created);
  await assert.rejects(workspaces.recover(created.id), /Git exit is unconfirmed/);
  created.host = `${hostname()}-other`;
  save(store, created);
  await assert.rejects(workspaces.recover(created.id), /execution host/);
  created.host = hostname();
  created.owner = { controllerPid: process.ppid, gitPid: null, exitConfirmed: true };
  save(store, created);
  await assert.rejects(workspaces.recover(created.id), /controller is alive/);
});

test('recovery cannot bless dirty contents and inspection detects replaced Git ownership', async t => {
  const { repo, store, task, workspaces, destination } = fixture(t);
  const created = await workspaces.create(task.id, 1, repo, destination);
  writeFileSync(join(destination, 'extra.txt'), 'untracked change');
  assert.equal((await workspaces.inspect(created.id)).dirty, true);
  created.phase = 'recovery_required';
  created.owner = { controllerPid: process.pid, gitPid: null, exitConfirmed: true };
  save(store, created);
  await assert.rejects(workspaces.recover(created.id), /clean base commit/);
  assert.equal(readFileSync(join(destination, 'extra.txt'), 'utf8'), 'untracked change');
  git(repo, 'worktree', 'unlock', destination);
  await assert.rejects(workspaces.inspect(created.id), /ownership lock/);
});

test('revising a task preserves its workspace but makes the old version unusable for a new attempt', async t => {
  const { repo, workflow, task, workspaces, destination } = fixture(t);
  const created = await workspaces.create(task.id, 1, repo, destination);
  workflow.revise(task.id, 1, { ...brief, title: 'New requirement' });
  workflow.approve(task.id, 2);
  assert.equal((await workspaces.inspect(created.id)).taskCurrent, false);
  assert.throws(() => workflow.start(task.id, agent), /earlier task version/);
});

test('workspace CLI persists state across processes and refuses Orca path overrides', t => {
  const { repo, db, task, destination } = fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [cli, '--db', db, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  assert.throws(
    () => run('workspace-new', task.id, '1', '--repo', repo, '--path', destination, '--orca'),
    /Orca chooses/,
  );
  const workspace = JSON.parse(run('workspace-new', task.id, '1', '--repo', repo, '--path', destination)) as Workspace;
  assert.equal(JSON.parse(run('workspace-inspect', workspace.id)).dirty, false);
  assert.equal(JSON.parse(run('workspace-show', workspace.id)).workspace.phase, 'ready');
  assert.equal(JSON.parse(run('workspace-list')).length, 1);
});

test('schema 2 journals gain workspace tables without changing tasks or conversation history', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-schema-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'journal.sqlite');
  const first = new Store(path);
  const task = new Workflow(first).create(brief);
  first.saveSession('existing', { id: 'existing', phase: 'idle' });
  first.appendSession('existing', 'fixture.event', { retained: true });
  first.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE workspace_events; DROP TABLE workspaces; PRAGMA user_version = 2;');
  legacy.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(new Workflow(reopened).get(task.id), task);
    assert.equal(reopened.events(task.id).length, 1);
    assert.deepEqual(reopened.session('existing'), { id: 'existing', phase: 'idle' });
    assert.deepEqual(reopened.sessionEvents('existing')[0]?.data, { retained: true });
    assert.deepEqual(reopened.workspaces(), []);
  } finally {
    reopened.close();
  }
});
