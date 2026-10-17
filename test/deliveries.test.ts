import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Workspaces } from '../src/workspaces.js';
import { Executions } from '../src/executions.js';
import { Checks } from '../src/checks.js';
import { Deliveries, type Delivery } from '../src/deliveries.js';
import { runCheckProcess } from '../src/check-process.js';
import type { ExecutionLease } from '../src/execution-state.js';

const windows = { skip: process.platform !== 'win32' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}
async function fixture(t: { after(fn: () => void): void }, prepare?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-delivery-test-')); const repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n"); writeFileSync(join(repo, 'obsolete.txt'), 'remove me\n');
  git(repo, 'add', '.'); git(repo, 'update-index', '--chmod=+x', 'greeting.js'); git(repo, 'commit', '-m', 'Baseline');
  const db = join(root, 'journal.sqlite'); const store = new Store(db);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workflow = new Workflow(store); const task = workflow.create({ title: 'Delivery fixture', outcome: 'Update greeting', criteria: ['Print hello world'], plan: 'Fixture evidence for delivery tests' });
  workflow.approve(task.id, 1);
  const workspaces = new Workspaces(store); const workspace = await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const execution = await new Executions(store).create(workspace.id, 1, 'codex');
  writeFileSync(join(workspace.path!, 'greeting.js'), "console.log('hello world');\n");
  rmSync(join(workspace.path!, 'obsolete.txt')); writeFileSync(join(workspace.path!, 'new.bin'), Buffer.from([0, 255, 42]));
  prepare?.(workspace.path!);
  const snapshot = await new Checks(store).snapshot(execution.id);
  workflow.finish(task.id, execution.attemptId, 1, 'succeeded', snapshot.artifact, 'Explicit trusted fixture submission');
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const) workflow.record(task.id, {
    id: kind, kind, artifact: snapshot.artifact, version: 1, attemptId: execution.attemptId, outcome: 'passed', source: 'controller',
    summary: 'Trusted test fixture evidence; no live inference', criteria: task.brief.criteria,
    ...(kind === 'review' ? { agent: { provider: 'claude' as const, model: 'fixture', sessionId: 'fixture-review' } } : {}) });
  const deliveries = new Deliveries(store);
  const spec = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, message: 'Update greeting', timeoutMs: 15_000 };
  return { root, repo, db, store, workflow, task, workspace, execution, snapshot, deliveries, spec };
}
function deadController(f: Awaited<ReturnType<typeof fixture>>): void {
  const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }));
  const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
  f.store.transaction(() => {
    f.store.releaseLease(f.workspace.id, f.execution.id, lease.runId);
    f.store.acquireLease(f.workspace.id, f.execution.id, lease.runId, { ...lease, controllerPid: pid });
  });
}
function crash(f: Awaited<ReturnType<typeof fixture>>, beforeDispatch: boolean): void {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const code = `import {Store} from ${url('store')}; import {Deliveries} from ${url('deliveries')}; import {Workspaces} from ${url('workspaces')}; import {runCheckProcess} from ${url('check-process')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    ${beforeDispatch ? 'workspaces.inspect = async () => process.exit(0);' : ''}
    await new Deliveries(store, workspaces).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(f.spec)}, undefined,
      async options => { await runCheckProcess(options); process.exit(0); });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
}

test('supervised delivery commits exact checked bytes, paths and executable modes then completes atomically', windows, async t => {
  const f = await fixture(t); const specFile = join(f.root, 'delivery.json'); writeFileSync(specFile, JSON.stringify(f.spec));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'execution-deliver', f.execution.id, specFile, '--db', f.db],
    { encoding: 'utf8', windowsHide: true })) as Delivery;
  assert.equal(result.phase, 'delivered', JSON.stringify(result));
  assert.equal(result.commit, git(f.workspace.path!, 'rev-parse', 'HEAD'));
  assert.equal(git(f.workspace.path!, 'show', '-s', '--format=%an <%ae> / %cn <%ce>'), 'Fixture <fixture@invalid> / Fixture <fixture@invalid>');
  assert.match(git(f.workspace.path!, 'ls-tree', 'HEAD', 'greeting.js'), /^100755/);
  assert.equal(git(f.workspace.path!, 'status', '--porcelain'), '');
  assert.equal(f.workflow.get(f.task.id).phase, 'complete'); assert.equal(f.store.lease(f.workspace.id), null);
  assert.ok(f.store.events(f.task.id).some(event => event.type === 'delivery.settled'));
  await assert.rejects(f.deliveries.run(f.execution.id, f.spec), /current submitted/);
});

test('delivery rejects missing gates and stale snapshots before any Git write', windows, async t => {
  const f = await fixture(t);
  f.workflow.record(f.task.id, { id: 'new-review', kind: 'review', artifact: f.snapshot.artifact, attemptId: f.execution.attemptId, version: 1,
    outcome: 'failed', source: 'controller', summary: 'Blocking fixture finding', agent: { provider: 'claude', model: 'fixture', sessionId: 'other-review' } });
  await assert.rejects(f.deliveries.run(f.execution.id, f.spec), /review has not passed/);
  assert.deepEqual(f.store.deliveries(f.execution.id), []);
  const g = await fixture(t); writeFileSync(join(g.workspace.path!, 'unreviewed.txt'), 'new content');
  const result = await g.deliveries.run(g.execution.id, g.spec);
  assert.equal(result.phase, 'failed'); assert.equal(result.dispatch, 'not_requested');
  assert.equal(git(g.workspace.path!, 'rev-parse', 'HEAD'), g.snapshot.head); assert.equal(g.store.lease(g.workspace.id), null);
});

test('Git normalization that changes reviewed bytes fails before commit and retains staged state', windows, async t => {
  const f = await fixture(t, path => { writeFileSync(join(path, '.gitattributes'), '*.txt text eol=lf\n'); writeFileSync(join(path, 'normalized.txt'), 'one\r\ntwo\r\n'); });
  const result = await f.deliveries.run(f.execution.id, f.spec);
  assert.equal(result.phase, 'failed'); assert.match(result.result!.stderr, /bytes differ/);
  assert.equal(git(f.workspace.path!, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('hook changes cannot turn a different commit into accepted delivery', windows, async t => {
  const f = await fixture(t); const hooks = join(f.repo, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "unreviewed\\n" > hook.txt\ngit add hook.txt\n');
  const result = await f.deliveries.run(f.execution.id, f.spec);
  assert.equal(result.phase, 'failed'); assert.notEqual(git(f.workspace.path!, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification'); assert.equal(result.commit, null);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('settled delivery with a lost reply requires explicit recovery and cannot use read-only recovery', windows, async t => {
  const f = await fixture(t);
  const result = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => { await runCheckProcess(options); throw new Error('Lost reply'); });
  assert.equal(result.phase, 'recovery_required'); assert.ok(f.store.lease(f.workspace.id));
  assert.throws(() => new Executions(f.store).recoverReadOnly(f.execution.id), /No recoverable read-only/);
  await assert.rejects(f.deliveries.recover(result.id), /controller is still alive/);
  deadController(f);
  const recovered = await f.deliveries.recover(result.id);
  assert.equal(recovered.phase, 'delivered', recovered.error ?? undefined); assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(git(f.workspace.path!, 'rev-list', '--count', 'HEAD'), '2');
});

test('absent processes without a matching delivery receipt cannot release ownership', windows, async t => {
  const f = await fixture(t);
  const result = await f.deliveries.run(f.execution.id, f.spec, undefined, async () => { throw new Error('Unknown dispatch'); });
  deadController(f);
  await assert.rejects(f.deliveries.recover(result.id)); assert.ok(f.store.lease(f.workspace.id));
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
});

test('actual controller exit after Git commit is recovered by CLI without replay', windows, async t => {
  const f = await fixture(t); crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!; assert.equal(pending.phase, 'running');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'delivery-recover', pending.id, '--db', f.db], { encoding: 'utf8', windowsHide: true })) as Delivery;
  assert.equal(result.phase, 'delivered', result.error ?? undefined); assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(git(f.workspace.path!, 'rev-list', '--count', 'HEAD'), '2');
});

test('pre-dispatch crash recovery releases only the proven unused delivery and never commits', windows, async t => {
  const f = await fixture(t); crash(f, true);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  const result = await f.deliveries.recover(pending.id);
  assert.equal(result.phase, 'interrupted'); assert.equal(result.dispatch, 'not_requested');
  assert.equal(git(f.workspace.path!, 'rev-parse', 'HEAD'), f.snapshot.head); assert.equal(f.store.lease(f.workspace.id), null);
});

test('recovery refuses a changed commit or working tree despite a successful settlement receipt', windows, async t => {
  const f = await fixture(t); crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  writeFileSync(join(f.workspace.path!, 'greeting.js'), 'changed after commit\n');
  const recovered = await f.deliveries.recover(pending.id);
  assert.equal(recovered.phase, 'failed'); assert.match(recovered.error!, /Working files/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('schema 7 migration retains evidence and adds empty delivery storage', windows, async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db); db.exec('DROP TABLE deliveries; PRAGMA user_version = 7;'); db.close();
  const migrated = new Store(f.db);
  try { assert.deepEqual(migrated.deliveries(f.execution.id), []); assert.equal(new Workflow(migrated).get(f.task.id).evidence.length, 4); }
  finally { migrated.close(); }
});

test('delivery timeout confirms tool exit and leaves task incomplete without automatic rollback', windows, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 10\n');
  const result = await f.deliveries.run(f.execution.id, { ...f.spec, timeoutMs: 1200 });
  assert.equal(result.phase, 'failed'); assert.equal(result.result?.reason, 'timed_out'); assert.equal(result.result?.exitConfirmed, true);
  assert.equal(f.store.lease(f.workspace.id), null); assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(git(f.workspace.path!, 'rev-parse', 'HEAD'), f.snapshot.head);
});

test('delivery recovery rejects a replaced commit even when its tree matches', windows, async t => {
  const f = await fixture(t); crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  git(f.workspace.path!, 'commit', '--amend', '-m', 'Unrelated replacement commit');
  const result = await f.deliveries.recover(pending.id);
  assert.equal(result.phase, 'failed'); assert.match(result.error!, /message or operation marker/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
});

test('delivery completion and journal acceptance roll back together on a database failure', windows, async t => {
  const f = await fixture(t); const append = f.store.append.bind(f.store); let fail = true;
  f.store.append = (id, version, type, data) => {
    if (type === 'delivery.settled' && fail) { fail = false; throw new Error('Injected journal failure'); }
    append(id, version, type, data);
  };
  const result = await f.deliveries.run(f.execution.id, f.spec);
  assert.equal(result.phase, 'failed'); assert.match(result.error!, /journal failure/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.ok(!f.store.events(f.task.id).some(event => event.type === 'task.completed'));
  assert.equal(f.store.lease(f.workspace.id), null);
});
