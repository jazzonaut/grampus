import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Workspaces, type Workspace } from '../src/workspaces.js';
import { OrcaCli, type OrcaTransport } from '../src/orca.js';

const brief = { title: 'Orca fixture', outcome: 'Isolate checkout', criteria: ['Base preserved'], plan: 'Create then inspect' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-orca-test-'));
  const repo = join(root, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture');
  const db = join(root, 'journal.sqlite');
  const store = new Store(db);
  const workflow = new Workflow(store);
  const task = workflow.create(brief); workflow.approve(task.id, 1);
  const requests: string[][] = [];
  const state: { worktree: Record<string, unknown> | null; loseReply: boolean; truncated: boolean; duplicate: boolean; empty: boolean; old: boolean } =
    { worktree: null, loseReply: false, truncated: false, duplicate: false, empty: false, old: false };
  const run: OrcaTransport = async (_cwd, args) => {
    requests.push(args);
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const response = (result: unknown) => JSON.stringify({ ok: true, result });
    if (args.includes('--help')) return state.old ? '--json' : '--setup --no-parent --base-branch --comment --json';
    if (args[0] === 'repo') return response({ repo: { id: 'fixture-repo', path: repo, kind: 'git' } });
    if (args[1] === 'create') {
      // Simulate Orca's host, including its own path/branch naming. Production only calls the CLI.
      const name = value('--name');
      const path = join(root, name);
      const branch = `fixture/${name}`;
      git(repo, 'worktree', 'add', '-b', branch, path, value('--base-branch'));
      state.worktree = { id: `fixture-repo::${path}`, repoId: 'fixture-repo', path, branch: `refs/heads/${branch}`,
        hostId: 'local', instanceId: 'instance-a', identity: { key: 'wt2:local:instance-a', instanceId: 'instance-a', executionHostId: 'local' },
        displayName: name, comment: value('--comment'), baseRef: value('--base-branch'), isMainWorktree: false, isArchived: false };
      if (state.loseReply) throw new Error('Fixture lost response');
      return response({ worktree: state.worktree });
    }
    if (args[1] === 'list') {
      const entries = state.worktree && !state.empty ? state.duplicate ? [state.worktree, state.worktree] : [state.worktree] : [];
      return response({ worktrees: entries, truncated: state.truncated, totalCount: entries.length, hostScope: { hostIds: ['local'], omittedHostIds: [] } });
    }
    if (args[1] === 'show') return response({ worktree: state.worktree });
    throw new Error('Unexpected fixture command');
  };
  const client = new OrcaCli(run);
  const workspaces = new Workspaces(store, client);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, db, store, workflow, task, workspaces, client, state, requests };
}

test('Orca creation pins the base without requesting agents or Orca setup hooks', async t => {
  const { repo, store, task, workspaces, requests } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'greeting.txt'), 'preserve dirty source\n');
  const before = git(repo, 'status', '--porcelain');
  const created = await workspaces.createOrca(task.id, 1, repo, 'main');
  assert.equal(created.adapter, 'orca');
  assert.equal(created.phase, 'ready');
  assert.equal(created.owner, null);
  assert.equal(created.baseCommit, base);
  assert.ok(created.branch.startsWith('fixture/'));
  assert.equal(created.orca?.identityKey, 'wt2:local:instance-a');
  assert.equal(git(repo, 'status', '--porcelain'), before);
  const create = requests.find(args => args[1] === 'create' && !args.includes('--help'))!;
  assert.ok(create.includes('--no-parent'));
  assert.equal(create[create.indexOf('--setup') + 1], 'skip');
  assert.equal(create[create.indexOf('--base-branch') + 1], base);
  assert.ok(!create.includes('--agent') && !create.includes('--activate') && !create.includes('--path'));
  assert.deepEqual(store.workspaceEvents(created.id).map(event => event.type), ['workspace.requested', 'orca.identity_recorded', 'workspace.ready']);
  assert.equal((await workspaces.inspect(created.id)).dirty, false);
});

test('a lost Orca reply is discovered after reopening without a second create request', async t => {
  const { repo, db, store, task, workspaces, client, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /must not be replayed/);
  const unknown = workspaces.list()[0]!;
  assert.equal(unknown.phase, 'recovery_required');
  assert.equal(unknown.path, null);
  assert.equal(unknown.orca?.identityKey, null);
  const reopened = new Store(db);
  try {
    const recovered = await new Workspaces(reopened, client).recover(unknown.id);
    assert.equal(recovered.phase, 'ready');
    assert.ok(recovered.path);
    assert.equal(recovered.orca?.identityKey, 'wt2:local:instance-a');
  } finally { reopened.close(); }
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
  assert.deepEqual(store.workspaceEvents(unknown.id).at(-1)?.data, { replayed: false });
});

test('missing, duplicate and truncated Orca discovery results retain the reservation without replay', async t => {
  const { repo, task, workspaces, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  const id = workspaces.list()[0]!.id;
  state.empty = true;
  await assert.rejects(workspaces.recover(id), /unknown or ambiguous/);
  state.empty = false; state.duplicate = true;
  await assert.rejects(workspaces.recover(id), /unknown or ambiguous/);
  state.duplicate = false; state.truncated = true;
  await assert.rejects(workspaces.recover(id), /incomplete/);
  assert.equal(workspaces.get(id).phase, 'recovery_required');
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca instance replacement at the same path is rejected while ordinary comment edits are allowed', async t => {
  const { repo, task, workspaces, state } = fixture(t);
  const created = await workspaces.createOrca(task.id, 1, repo, 'main');
  state.worktree!.comment = 'User edited the status';
  assert.equal((await workspaces.inspect(created.id)).dirty, false);
  state.worktree!.instanceId = 'instance-b';
  state.worktree!.identity = { key: 'wt2:local:instance-b', instanceId: 'instance-b', executionHostId: 'local' };
  await assert.rejects(workspaces.inspect(created.id), /instance.*changed/);
});

test('Orca recovery refuses an altered base or dirty checkout and never resets changes', async t => {
  const { repo, task, workspaces, state } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  const saved = workspaces.list()[0]!;
  state.worktree!.baseRef = 'other-base';
  await assert.rejects(workspaces.recover(saved.id), /does not match/);
  state.worktree!.baseRef = saved.baseCommit;
  writeFileSync(join(String(state.worktree!.path), 'extra.txt'), 'preserve this');
  await assert.rejects(workspaces.recover(saved.id), /clean base commit/);
  assert.equal(workspaces.get(saved.id).phase, 'recovery_required');
  assert.match(git(String(state.worktree!.path), 'status', '--porcelain'), /extra.txt/);
});

test('Orca compatibility and approval failures stop before reserving or creating a workspace', async t => {
  const { repo, task, workspaces, state, requests } = fixture(t);
  await assert.rejects(workspaces.createOrca(task.id, 2, repo, 'main'), /exact approved/);
  state.old = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /lacks required/);
  assert.equal(workspaces.list().length, 0);
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 0);
});

test('Orca and standalone creation share one task reservation', async t => {
  const { root, repo, task, workspaces, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  await assert.rejects(workspaces.create(task.id, 1, repo, join(root, 'duplicate')), /reservation/);
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /reservation/);
  assert.equal(workspaces.list().length, 1);
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca protocol rejects remote identity, incomplete listing and malformed responses', async () => {
  const list = (result: unknown) => new OrcaCli(async () => JSON.stringify({ ok: true, result })).list('.', 'repo');
  await assert.rejects(list({ worktrees: [], truncated: false, totalCount: 1, hostScope: { hostIds: ['local'], omittedHostIds: [] } }), /incomplete/);
  await assert.rejects(list({ worktrees: [], truncated: false, totalCount: 0, hostScope: { hostIds: ['remote'], omittedHostIds: [] } }), /another host/);
  await assert.rejects(new OrcaCli(async () => '{bad json').show('.', 'identity'));
  await assert.rejects(new OrcaCli(async () => JSON.stringify({ ok: false, error: { code: 'repo_not_found' } })).show('.', 'identity'), /repo_not_found/);
  await assert.rejects(new OrcaCli(async () => JSON.stringify({ ok: true, result: { worktree: { hostId: 'remote', identity: { executionHostId: 'remote' } } } })).show('.', 'identity'), /Only local/);
});

test('schema 3 standalone workspaces survive the Orca-aware schema upgrade', async t => {
  const { root, repo, task, workspaces, workflow } = fixture(t);
  const created = await workspaces.create(task.id, 1, repo, join(root, 'standalone'));
  const legacyPath = join(root, 'legacy.sqlite');
  const first = new Store(legacyPath);
  first.save(task.id, workflow.get(task.id));
  first.saveWorkspace(created.id, task.id, created.path, created);
  first.appendWorkspace(created.id, 'workspace.ready', {});
  first.close();
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec('PRAGMA user_version = 3;'); legacy.close();
  const upgraded = new Store(legacyPath);
  try {
    assert.deepEqual(upgraded.workspace<Workspace>(created.id), created);
    assert.equal(upgraded.workspaceEvents(created.id).length, 1);
  } finally { upgraded.close(); }
});
