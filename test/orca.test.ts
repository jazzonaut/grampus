import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow, type Brief } from '../src/workflow.js';
import { Workspaces, type Workspace } from '../src/workspaces.js';
import { OrcaCli, type OrcaTransport } from '../src/orca.js';
import { Executions } from '../src/executions.js';
import { runSession } from '../src/sessions.js';
import type { Connector } from '../src/agents/types.js';
import { Sessions } from '../src/sessions.js';
import { Checks } from '../src/checks.js';
import { Implementations } from '../src/implementations.js';
import { Deliveries } from '../src/deliveries.js';
import { deliverRepository } from '../src/delivery-operation.js';
import type { DeliveryRequest } from '../src/delivery-git.js';
import { runCheckProcess, type CheckProcessOptions, type CheckProcessResult } from '../src/check-process.js';
import type { ExecutionLease } from '../src/execution-state.js';

const brief = { title: 'Orca fixture', outcome: 'Isolate checkout', criteria: ['Base preserved'], plan: 'Create then inspect' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function fixture(t: { after(fn: () => void): void }, taskBrief: Brief = brief) {
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
  const task = workflow.create(taskBrief); workflow.approve(task.id, 1);
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

test('Orca execution holds a lease during identity inspection and refuses a replaced instance before dispatch', async t => {
  const { repo, store, task, workspaces, state } = fixture(t);
  const workspace = await workspaces.createOrca(task.id, 1, repo, 'main');
  const execution = await new Executions(store, workspaces).create(workspace.id, 1, 'codex');
  let turns = 0;
  const connector: Connector = async () => {
    assert.ok(store.lease(workspace.id));
    return { turn: async () => { turns++; return { status: 'completed', reply: { kind: 'message', text: 'Fixture', questions: [], findings: [] }, usage: null, error: null }; },
      interrupt: async () => {}, close: async () => { assert.ok(store.lease(workspace.id)); } };
  };
  assert.equal((await runSession(store, execution.sessionId, 'First', {}, connector, workspaces)).status, 'completed');
  assert.equal(store.lease(workspace.id), null);
  state.worktree!.instanceId = 'replacement';
  state.worktree!.identity = { key: 'wt2:local:replacement', instanceId: 'replacement', executionHostId: 'local' };
  assert.equal((await runSession(store, execution.sessionId, 'Second', {}, connector, workspaces)).status, 'failed');
  assert.equal(turns, 1);
  assert.equal(store.lease(workspace.id), null);
});

const windows = { skip: process.platform !== 'win32' };
async function implementationFixture(t: { after(fn: () => void): void }, provider: 'claude' | 'codex' = 'codex', taskBrief: Brief = brief) {
  const f = fixture(t, taskBrief);
  const workspace = await f.workspaces.createOrca(f.task.id, 1, f.repo, 'main');
  const execution = await new Executions(f.store, f.workspaces).create(workspace.id, 1, provider);
  const checks = new Checks(f.store, f.workspaces); const snapshot = await checks.snapshot(execution.id);
  const policy = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: ['greeting.txt'] };
  return { ...f, workspace, execution, checks, snapshot, policy, implementations: new Implementations(f.store, f.workspaces) };
}
function editedResult(options: CheckProcessOptions) {
  writeFileSync(join(options.cwd, 'greeting.txt'), 'hello world\n');
  writeFileSync(join(options.receipt!.directory, 'result.json'), JSON.stringify({ id: options.receipt!.checkId,
    result: { status: 'completed', reply: { kind: 'message', text: 'Fixture edited greeting', questions: [], findings: [] }, usage: null, error: null } }));
  return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}

test('both native providers can edit an Orca workspace without changing its lifecycle or accepting gates', windows, async t => {
  for (const provider of ['claude', 'codex'] as const) {
    const f = await implementationFixture(t, provider);
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      assert.equal(f.store.lease<ExecutionLease>(f.workspace.id)?.kind, 'implementation');
      return editedResult(options);
    });
    assert.equal(run.phase, 'completed', run.error ?? undefined);
    assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal(new Sessions(f.store).get(f.execution.sessionId).mode, 'editing');
    assert.equal(f.store.lease(f.workspace.id), null);
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.workspace.baseCommit);
    assert.ok(f.requests.every(args => ['repo', 'worktree'].includes(args[0]!) && !['set', 'rm'].includes(args[1]!)));
  }
});

test('Orca editing refuses changed identity before dispatch and cannot accept edits after archival', windows, async t => {
  const f = await implementationFixture(t); let dispatched = false;
  f.state.worktree!.instanceId = 'replacement';
  const rejected = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => { dispatched = true; return editedResult(options); });
  assert.equal(dispatched, false); assert.equal(rejected.phase, 'failed'); assert.equal(rejected.dispatch, 'not_requested');
  const g = await implementationFixture(t);
  const edited = await g.implementations.run(g.execution.id, g.policy, undefined, {}, async options => {
    const result = editedResult(options); g.state.worktree!.isArchived = true; return result;
  });
  assert.equal(edited.phase, 'failed'); assert.match(edited.error!, /changed/);
  assert.equal(readFileSync(join(g.workspace.path, 'greeting.txt'), 'utf8'), 'hello world\n');
  assert.equal(g.store.lease(g.workspace.id), null); // Exit is proven; failed edits stay intact.
});

async function deliveryFixture(t: { after(fn: () => void): void }, noChange = false, taskBrief: Brief = brief) {
  const f = await implementationFixture(t, 'codex', taskBrief);
  if (!noChange) writeFileSync(join(f.workspace.path, 'greeting.txt'), 'hello world\n');
  const snapshot = await f.checks.snapshot(f.execution.id);
  f.workflow.finish(f.task.id, f.execution.attemptId, 1, 'succeeded', snapshot.artifact, 'Trusted fixture submission');
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const) f.workflow.record(f.task.id, {
    id: kind, kind, artifact: snapshot.artifact, version: 1, attemptId: f.execution.attemptId, outcome: 'passed', source: 'controller',
    summary: 'Offline fixture gates; no live inference', criteria: f.task.brief.criteria,
    ...(kind === 'review' ? { agent: { provider: 'claude' as const, model: 'fixture', sessionId: 'independent-fixture' } } : {}) });
  return { ...f, snapshot, deliveries: new Deliveries(f.store, f.workspaces),
    spec: { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, message: 'Deliver Orca fixture', timeoutMs: 15000 } };
}

// Simulate only Orca's identity RPC. The real writer still runs inside the Job Object.
async function supervisedOrcaWriter(f: Awaited<ReturnType<typeof deliveryFixture>>, options: CheckProcessOptions) {
  const identityFile = join(f.root, 'orca-identity.json'); writeFileSync(identityFile, JSON.stringify(f.state.worktree));
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const script = `import {readFileSync} from 'node:fs'; import {deliverRepository} from ${url('delivery-operation')};
    import {Workspaces} from ${url('workspaces')}; import {OrcaCli} from ${url('orca')};
    const request=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const client=new OrcaCli(async()=>JSON.stringify({ok:true,result:{worktree:JSON.parse(readFileSync(process.argv[2],'utf8'))}}));
    console.log(await deliverRepository(request,process.argv[1]+'.message',store=>new Workspaces(store,client)));`;
  return runCheckProcess({ ...options, args: ['--input-type=module', '-e', script, options.args[1]!, identityFile] });
}

test('Orca delivery runs the supervised Git writer, preserves identity and completes exact checked content', windows, async t => {
  const f = await deliveryFixture(t);
  const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, options => supervisedOrcaWriter(f, options));
  assert.equal(delivery.phase, 'delivered', JSON.stringify(delivery));
  assert.equal(delivery.request?.orca?.identityKey, f.workspace.orca!.identityKey);
  assert.equal(git(f.workspace.path, 'show', '-s', '--format=%an <%ae> / %cn <%ce>'), 'Fixture <fixture@invalid> / Fixture <fixture@invalid>');
  assert.equal(git(f.workspace.path, 'status', '--porcelain'), '');
  assert.equal(f.workflow.get(f.task.id).phase, 'complete'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('Orca slices reuse the original instance and base, with identity checks before continuation', windows, async t => {
  const slice = { title: 'First', plan: 'Deliver fixture greeting', criteria: brief.criteria };
  const f = await deliveryFixture(t, false, { ...brief, slices: [slice, { ...slice, title: 'Integration' }] });
  const first = await f.deliveries.run(f.execution.id, f.spec, undefined, options => supervisedOrcaWriter(f, options));
  assert.equal(first.phase, 'delivered', JSON.stringify(first));
  assert.equal(f.workflow.get(f.task.id).phase, 'ready');
  assert.equal(f.workflow.get(f.task.id).slice!.completed.length, 1);
  const executions = new Executions(f.store, f.workspaces);
  f.state.worktree!.isArchived = true;
  await assert.rejects(executions.create(f.workspace.id, 1, 'codex'), /changed/);
  f.state.worktree!.isArchived = false;
  const next = await executions.create(f.workspace.id, 1, 'codex');
  assert.equal(next.headAtCreation, first.commit);
  const snapshot = await f.checks.snapshot(next.id);
  f.workflow.finish(f.task.id, next.attemptId, 1, 'succeeded', snapshot.artifact, 'Trusted final integration fixture submission');
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const) f.workflow.record(f.task.id, {
    id: `${next.id}:${kind}`, kind, artifact: snapshot.artifact, version: 1, attemptId: next.attemptId, outcome: 'passed', source: 'controller',
    summary: 'Offline integration fixture gates; no live inference', criteria: brief.criteria,
    ...(kind === 'review' ? { agent: { provider: 'claude', model: 'fixture', sessionId: 'final-fixture-review' } } : {}),
  });
  const last = await f.deliveries.run(next.id, { ...f.spec, artifact: snapshot.artifact, mode: 'no_change' }, undefined, options => supervisedOrcaWriter(f, options));
  assert.equal(last.phase, 'delivered', JSON.stringify(last)); assert.equal(last.outcome, 'no_change');
  assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(f.workspaces.get(f.workspace.id).baseCommit, f.workspace.baseCommit);
  assert.equal(f.workspaces.get(f.workspace.id).orca!.identityKey, f.workspace.orca!.identityKey);
  assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(f.requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca delivery worker rechecks ownership before staging and before commit', windows, async t => {
  for (const changeAt of [1, 3]) {
    const f = await deliveryFixture(t); let observations = 0;
    const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
      const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as DeliveryRequest;
      await assert.rejects(deliverRepository(request, join(f.root, 'message'), store => {
        const workspaces = new Workspaces(store, f.client); const inspect = workspaces.inspect.bind(workspaces);
        workspaces.inspect = async (...args) => { if (++observations === changeAt) f.state.worktree!.isArchived = true; return inspect(...args); };
        return workspaces;
      }), /changed/);
      return { reason: 'exited', exitCode: 1, exitConfirmed: true, stdout: '', stderr: 'Fixture identity changed', outputTruncated: false };
    });
    assert.equal(delivery.phase, 'failed'); assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(git(f.workspace.path, 'diff', '--cached', '--name-only'), changeAt === 1 ? '' : 'greeting.txt');
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  }
});

test('Orca writer rejects a request that differs from the durable delivery binding', windows, async t => {
  const f = await deliveryFixture(t);
  const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as DeliveryRequest;
    request.orca!.identityKey = 'wt2:local:replacement';
    await assert.rejects(deliverRepository(request, join(f.root, 'message'), store => new Workspaces(store, f.client)), /no longer owns/);
    return { reason: 'exited', exitCode: 1, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  });
  assert.equal(delivery.phase, 'failed'); assert.equal(git(f.workspace.path, 'diff', '--cached', '--name-only'), '');
});

test('Orca identity replacement after a confirmed commit cannot complete the task', windows, async t => {
  const f = await deliveryFixture(t);
  const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
    const result = await supervisedOrcaWriter(f, options); f.state.worktree!.isArchived = true; return result;
  });
  assert.equal(delivery.phase, 'failed'); assert.equal(delivery.commit, null);
  assert.notEqual(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('Orca lost-reply delivery recovery needs a receipt and the original workspace identity', windows, async t => {
  for (const mode of ['commit', 'no_change'] as const) for (const replaced of [false, true]) {
    const f = await deliveryFixture(t, mode === 'no_change');
    let writerResult: CheckProcessResult | undefined;
    const delivery = await f.deliveries.run(f.execution.id, { ...f.spec, mode }, undefined, async options => {
      writerResult = await supervisedOrcaWriter(f, options); throw new Error('Fixture lost controller reply');
    });
    assert.equal(writerResult?.reason, 'exited', JSON.stringify(writerResult));
    assert.equal(writerResult?.exitCode, 0, JSON.stringify(writerResult));
    assert.equal(delivery.phase, 'recovery_required');
    const head = git(f.workspace.path, 'rev-parse', 'HEAD');
    const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }));
    const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
    f.store.transaction(() => {
      f.store.releaseLease(f.workspace.id, f.execution.id, lease.runId);
      f.store.acquireLease(f.workspace.id, f.execution.id, lease.runId, { ...lease, controllerPid: pid });
    });
    if (replaced) f.state.worktree!.isArchived = true;
    const recovered = await f.deliveries.recover(delivery.id);
    assert.equal(recovered.phase, replaced ? 'failed' : 'delivered');
    assert.equal(recovered.outcome, replaced ? null : mode === 'commit' ? 'committed' : 'no_change');
    if (mode === 'no_change') { assert.equal(recovered.commit, null); assert.equal(head, f.snapshot.head); }
    assert.equal(f.workflow.get(f.task.id).phase, replaced ? 'awaiting_verification' : 'complete');
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), head); assert.equal(f.store.lease(f.workspace.id), null);
  }
});

test('Orca no-change delivery verifies the original instance in the worker and at acceptance', windows, async t => {
  for (const archive of ['never', 'worker', 'acceptance']) {
    const f = await deliveryFixture(t, true);
    const delivery = await f.deliveries.run(f.execution.id, { ...f.spec, mode: 'no_change' }, undefined, async options => {
      if (archive === 'worker') f.state.worktree!.isArchived = true;
      const result = await supervisedOrcaWriter(f, options);
      if (archive === 'acceptance') f.state.worktree!.isArchived = true;
      return result;
    });
    assert.equal(delivery.phase, archive === 'never' ? 'delivered' : 'failed', JSON.stringify(delivery));
    assert.equal(delivery.outcome, archive === 'never' ? 'no_change' : null); assert.equal(delivery.commit, null);
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(git(f.workspace.path, 'status', '--porcelain'), '');
    assert.equal(f.workflow.get(f.task.id).phase, archive === 'never' ? 'complete' : 'awaiting_verification');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});
