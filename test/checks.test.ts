import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Workspaces } from '../src/workspaces.js';
import { Sessions } from '../src/sessions.js';
import { Executions } from '../src/executions.js';
import { Checks, type CheckSpec, type RepositoryCheck } from '../src/checks.js';
import { runCheckProcess } from '../src/check-process.js';

const windows = { skip: process.platform !== 'win32' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-check-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'AGENTS.md'), 'Check the greeting output.\n');
  writeFileSync(join(repo, '.gitignore'), 'generated/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture baseline');
  const db = join(root, 'journal.sqlite'); const store = new Store(db);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workflow = new Workflow(store); const task = workflow.create({ title: 'Greeting', outcome: 'Print hello', criteria: ['Print hello'], plan: 'Implement and check' });
  workflow.approve(task.id, 1);
  const workspaces = new Workspaces(store); const workspace = await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const executions = new Executions(store); const execution = await executions.create(workspace.id, 1, 'codex');
  const checks = new Checks(store);
  const spec = async (code = "console.log('check passed')"): Promise<CheckSpec> => {
    const snapshot = await checks.snapshot(execution.id);
    return { name: 'Fixture check', file: process.execPath, args: ['-e', code], timeoutMs: 5000, artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest };
  };
  return { root, repo, db, store, task, workflow, workspace, workspaces, execution, executions, checks, spec };
}
async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Fixture wait timed out'); await delay(25); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

test('real check records content and output, then explicit submission passes only validation', windows, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('hello world');\n");
  const spec = await f.spec("const {execFileSync}=require('node:child_process'); const assert=require('node:assert/strict'); assert.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n'); console.log('greeting verified');");
  const check = await f.checks.run(f.execution.id, spec);
  assert.equal(check.phase, 'passed', JSON.stringify(check));
  assert.equal(check.result?.stdout, 'greeting verified\n'); assert.equal(check.result?.exitConfirmed, true);
  assert.ok(check.supervisorPid); assert.ok(check.toolPid);
  assert.equal(check.before!.diff.find(item => item.path === 'greeting.js')?.content, "console.log('hello world');\n");
  assert.equal(check.before!.diff.find(item => item.path === 'greeting.js')?.previousContent, "console.log('hello');\n");
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
  const reopened = new Store(f.db);
  try { await new Checks(reopened).finish(f.execution.id, check.id); } finally { reopened.close(); }
  const task = f.workflow.get(f.task.id);
  assert.equal(task.phase, 'awaiting_verification'); assert.equal(task.attempt?.artifact, check.after!.artifact);
  assert.deepEqual(task.evidence.map(item => item.kind), ['validation']);
  assert.throws(() => f.workflow.complete(task.id), /simplification.*review.*verification/);
});

test('snapshots bind index, untracked files and inherited instructions while excluding ignored build output', async t => {
  const f = await fixture(t); const initial = await f.checks.snapshot(f.execution.id);
  assert.ok(initial.instructions.some(item => item.path === 'AGENTS.md'));
  mkdirSync(join(f.workspace.path!, 'generated')); writeFileSync(join(f.workspace.path!, 'generated', 'out'), 'build');
  assert.equal((await f.checks.snapshot(f.execution.id)).artifact, initial.artifact);
  writeFileSync(join(f.workspace.path!, 'new.txt'), 'new');
  const untracked = await f.checks.snapshot(f.execution.id); assert.notEqual(untracked.artifact, initial.artifact);
  git(f.workspace.path!, 'add', 'new.txt'); assert.notEqual((await f.checks.snapshot(f.execution.id)).artifact, untracked.artifact);
  writeFileSync(join(f.root, 'CLAUDE.md'), 'Inherited fixture instructions');
  const inherited = await f.checks.snapshot(f.execution.id);
  assert.ok(inherited.instructions.some(item => item.path === '<ancestor:1>/CLAUDE.md'));
  assert.notEqual(inherited.instructionsDigest, initial.instructionsDigest);
});

test('stale artifact and instruction acknowledgements reject dispatch and preserve attempt state', async t => {
  const f = await fixture(t); const spec = await f.spec();
  writeFileSync(join(f.workspace.path!, 'AGENTS.md'), 'New rule');
  let called = false;
  const check = await f.checks.run(f.execution.id, spec, undefined, async () => { called = true; throw new Error('Unexpected dispatch'); });
  assert.equal(called, false); assert.equal(check.phase, 'failed'); assert.match(check.error!, /instructions changed/);
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('checks share the session lease, persist intent before dispatch and reject duplicate ownership', async t => {
  const f = await fixture(t); const spec = await f.spec();
  const check = await f.checks.run(f.execution.id, spec, undefined, async () => {
    assert.equal(f.store.checks<RepositoryCheck>(f.execution.id).at(-1)?.phase, 'running');
    assert.equal(f.store.executionEvents(f.execution.id).at(-1)?.type, 'check.dispatch_requested');
    assert.throws(() => new Sessions(f.store).claim(f.execution.sessionId, 'Compete'), /lease/);
    await assert.rejects(f.checks.run(f.execution.id, spec, undefined, async () => { throw new Error('Unexpected dispatch'); }), /lease/);
    assert.throws(() => f.executions.close(f.execution.id), /lease/);
    return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  });
  assert.equal(check.phase, 'passed');
});

test('failed and mutating commands remain failures; an older passing result cannot hide a newer failure', windows, async t => {
  const f = await fixture(t);
  const pass = await f.checks.run(f.execution.id, await f.spec()); assert.equal(pass.phase, 'passed');
  const failed = await f.checks.run(f.execution.id, await f.spec("console.error('broken'); process.exit(7)"));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.result?.exitCode, 7); assert.equal(failed.result?.stderr, 'broken\n');
  await assert.rejects(f.checks.finish(f.execution.id, pass.id), /latest check/);
  const changed = await f.checks.run(f.execution.id, await f.spec("require('node:fs').writeFileSync('greeting.js','changed')"));
  assert.equal(changed.phase, 'failed'); assert.match(changed.error!, /changed repository/);
  assert.notEqual(changed.before!.artifact, changed.after!.artifact);
  assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
});

test('submission rechecks repository state and rolls back both success and evidence on journal failure', windows, async t => {
  const f = await fixture(t); const check = await f.checks.run(f.execution.id, await f.spec());
  writeFileSync(join(f.workspace.path!, 'new.txt'), 'later edit');
  await assert.rejects(f.checks.finish(f.execution.id, check.id), /changed after the check/);
  rmSync(join(f.workspace.path!, 'new.txt'));
  const append = f.store.append.bind(f.store);
  f.store.append = (id, version, type, data) => { if (type === 'evidence.recorded') throw new Error('Fixture journal failure'); append(id, version, type, data); };
  await assert.rejects(f.checks.finish(f.execution.id, check.id), /journal failure/);
  f.store.append = append;
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
  await f.checks.finish(f.execution.id, check.id);
});

test('unknown tool shutdown keeps ownership across restarts and cannot use conversation recovery', async t => {
  const f = await fixture(t); const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => { throw new Error('Lost supervisor'); });
  assert.equal(check.phase, 'recovery_required'); assert.ok(f.store.lease(f.workspace.id));
  assert.equal(f.workflow.get(f.task.id).phase, 'recovery_required');
  const reopened = new Store(f.db);
  try {
    assert.equal(new Checks(reopened).get(check.id).phase, 'recovery_required');
    assert.throws(() => new Sessions(reopened).recover(f.execution.sessionId), /does not need recovery/);
    assert.throws(() => new Executions(reopened).close(f.execution.id), /lease/);
  } finally { reopened.close(); }
});

test('job supervision passes literal Unicode arguments and records a failed executable launch', windows, async () => {
  const args = ['a b', 'quote"end', 'trailing\\', '$(not-a-command)', 'héllo 🌊', ''];
  const result = await runCheckProcess({ file: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args], cwd: process.cwd(), timeoutMs: 3000, started: () => {} });
  assert.equal(result.reason, 'exited'); assert.equal(result.exitConfirmed, true); assert.deepEqual(JSON.parse(result.stdout), args);
  const missing = await runCheckProcess({ file: join(tmpdir(), 'grampus-missing-executable.exe'), args: [], cwd: process.cwd(), timeoutMs: 1000, started: () => {} });
  assert.equal(missing.reason, 'supervisor_error'); assert.equal(missing.exitConfirmed, true);
});

test('timeout terminates a real tool tree before releasing the workspace', windows, async t => {
  const f = await fixture(t);
  const spec = await f.spec("const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);");
  spec.timeoutMs = 700;
  const check = await f.checks.run(f.execution.id, spec);
  assert.equal(check.phase, 'failed'); assert.equal(check.result?.reason, 'timed_out'); assert.equal(check.result.exitConfirmed, true);
  assert.equal(alive(check.toolPid!), false); assert.equal(alive(Number(check.result.stdout.trim())), false);
  assert.equal(f.store.lease(f.workspace.id), null); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
});

test('a zero-exit tool leaving a detached child is failed and its child is terminated', windows, async () => {
  const result = await runCheckProcess({ file: process.execPath, args: ['-e', "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); console.log(child.pid); child.unref();"], cwd: process.cwd(), timeoutMs: 3000, started: () => {} });
  assert.equal(result.reason, 'descendants_remaining'); assert.equal(result.exitCode, 0); assert.equal(result.exitConfirmed, true);
  assert.equal(alive(Number(result.stdout.trim())), false);
});

test('cancellation stops actual tools and excessive output is bounded and unsuccessful', windows, async () => {
  const abort = new AbortController(); let toolPid = 0;
  const result = await runCheckProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 3000, signal: abort.signal,
    started: (kind, pid) => { if (kind === 'tool') { toolPid = pid; abort.abort(); } } });
  assert.equal(result.reason, 'interrupted'); assert.equal(result.exitConfirmed, true); assert.equal(alive(toolPid), false);
  const noisy = await runCheckProcess({ file: process.execPath, args: ['-e', "const fs=require('node:fs'); const b=Buffer.alloc(100000,'x'); setInterval(()=>fs.writeSync(1,b),1)"], cwd: process.cwd(), timeoutMs: 3000, started: () => {} });
  assert.equal(noisy.reason, 'output_limit'); assert.equal(noisy.exitConfirmed, true); assert.equal(noisy.outputTruncated, true); assert.ok(noisy.stdout.length <= 65536);
});

test('killing the controller shuts down its tool tree without automatically releasing the durable lease', windows, async t => {
  const f = await fixture(t); const childFile = join(f.root, 'child-pid');
  const spec = await f.spec(`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(child.pid)); setInterval(()=>{},1000);`);
  const specFile = join(f.root, 'check.json'); writeFileSync(specFile, JSON.stringify(spec));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const controller = execFile(process.execPath, [cli, 'execution-check', f.execution.id, specFile, '--db', f.db], { windowsHide: true });
  controller.on('error', () => {});
  const closed = new Promise<void>(resolve => controller.once('close', () => resolve()));
  t.after(() => controller.kill());
  await waitFor(() => { try { return Number(readFileSync(childFile, 'utf8')) > 0; } catch { return false; } });
  const check = f.store.checks<RepositoryCheck>(f.execution.id).at(-1)!;
  const childPid = Number(readFileSync(childFile, 'utf8'));
  controller.kill(); await closed;
  await waitFor(() => !alive(check.toolPid!) && !alive(childPid) && !alive(check.supervisorPid!));
  assert.ok(f.store.lease(f.workspace.id));
  assert.equal(f.checks.get(check.id).phase, 'running'); // No final controller transaction was committed.
  assert.throws(() => f.executions.close(f.execution.id), /lease/);
});

test('schema 5 journals migrate without losing linked records', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db); db.exec('DROP TABLE checks; PRAGMA user_version = 5;'); db.close();
  const migrated = new Store(f.db);
  try { assert.deepEqual(migrated.execution(f.execution.id), f.execution); assert.deepEqual(migrated.checks(f.execution.id), []); }
  finally { migrated.close(); }
});

test('supervisor death kills its job but does not invent exit confirmation', windows, async () => {
  let supervisorPid = 0; let toolPid = 0;
  const result = await runCheckProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 3000,
    started: (kind, pid) => { if (kind === 'supervisor') supervisorPid = pid; else { toolPid = pid; process.kill(supervisorPid); } } });
  assert.equal(result.reason, 'supervisor_lost'); assert.equal(result.exitConfirmed, false);
  await waitFor(() => !alive(toolPid));
});

test('CLI snapshots, executes and submits a check across separate controllers without inference', windows, async t => {
  const f = await fixture(t); const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--db', f.db],
    { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })) as Record<string, unknown>;
  const snapshot = invoke('execution-snapshot', f.execution.id);
  const specFile = join(f.root, 'check.json');
  writeFileSync(specFile, JSON.stringify({ name: 'CLI fixture', file: process.execPath, args: ['greeting.js'], timeoutMs: 3000,
    artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest }));
  const check = invoke('execution-check', f.execution.id, specFile);
  assert.equal(check.phase, 'passed');
  assert.equal(invoke('check-show', check.id as string).id, check.id);
  assert.equal(invoke('execution-finish', f.execution.id, check.id as string).phase, 'awaiting_verification');
});

test('invalid options and unsupported snapshot file types fail before dispatch or evidence', async t => {
  const f = await fixture(t); const spec = await f.spec();
  await assert.rejects(f.checks.run(f.execution.id, { ...spec, cwd: f.repo } as CheckSpec), /Unknown check option/);
  assert.deepEqual(f.store.checks(f.execution.id), []);
  const oid = git(f.workspace.path!, 'rev-parse', 'HEAD');
  git(f.workspace.path!, 'update-index', '--add', '--cacheinfo', `160000,${oid},nested`);
  await assert.rejects(f.checks.snapshot(f.execution.id), /submodules/);
  assert.equal(f.store.lease(f.workspace.id), null); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
});
