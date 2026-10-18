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
import { Sessions, runSession } from '../src/sessions.js';
import { Executions } from '../src/executions.js';
import { Checks, type CheckSpec, type RepositoryCheck } from '../src/checks.js';
import { runCheckProcess, retainedOutput } from '../src/check-process.js';
import type { ExecutionLease } from '../src/execution-state.js';
import type { Connector, Reply } from '../src/agents/types.js';
import { processAlive } from '../src/check-recovery.js';

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

test('rapid zero-exit tools wait for job settlement instead of failing on transient accounting', windows, async () => {
  for (let batch = 0; batch < 6; batch++) {
    const results = await Promise.all(Array.from({ length: 4 }, () => runCheckProcess({ file: process.execPath,
      args: ['-e', 'process.stdout.write("settled")'], cwd: process.cwd(), timeoutMs: 3000, started: () => {} })));
    for (const result of results) {
      assert.equal(result.reason, 'exited', JSON.stringify(result));
      assert.equal(result.exitCode, 0); assert.equal(result.exitConfirmed, true); assert.equal(result.stdout, 'settled');
    }
  }
});

test('timeout terminates a real tool tree before releasing the workspace', windows, async t => {
  const f = await fixture(t);
  const identityModule = JSON.stringify(new URL('../src/process-identity.js', import.meta.url).href);
  const spec = await f.spec(`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    import(${identityModule}).then(({inspectProcess}) => console.log(JSON.stringify({ childPid: child.pid, tool: inspectProcess(process.pid), child: inspectProcess(child.pid) })));
    setInterval(()=>{},1000);`);
  // Leave time to observe both creation times before the actual timeout. A later
  // repository capture can give Windows enough time to recycle the exited PIDs.
  spec.timeoutMs = 5000;
  const check = await f.checks.run(f.execution.id, spec);
  assert.equal(check.phase, 'failed'); assert.equal(check.result?.reason, 'timed_out'); assert.equal(check.result.exitConfirmed, true);
  const identities = JSON.parse(check.result.stdout.trim()) as { childPid: number; tool: { state: string; startedAt: string }; child: { state: string; startedAt: string } };
  assert.equal(identities.tool.state, 'present'); assert.equal(identities.child.state, 'present');
  assert.ok(Number.isSafeInteger(identities.childPid) && identities.childPid > 0);
  assert.equal(processAlive(check.toolPid!, identities.tool.startedAt), false);
  assert.equal(processAlive(identities.childPid, identities.child.startedAt), false);
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

test('controller crash shuts down its tree and explicit receipt recovery releases ownership without replay', windows, async t => {
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
  const recovered = JSON.parse(execFileSync(process.execPath, [cli, 'check-recover', check.id, '--db', f.db], { encoding: 'utf8', windowsHide: true })) as RepositoryCheck;
  assert.equal(recovered.phase, 'interrupted'); assert.equal(recovered.result?.exitConfirmed, true);
  assert.equal(f.store.lease(f.workspace.id), null); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.throws(() => f.checks.recover(check.id), /lease/);
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
  const acceptance = { name: 'Greeting acceptance', file: process.execPath, args: ['greeting.js'], timeoutMs: 3000,
    artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, criteria: ['Print hello'], expectedStdout: 'hello\n' };
  writeFileSync(specFile, JSON.stringify(acceptance));
  assert.equal(invoke('execution-verify', f.execution.id, specFile).phase, 'passed');
  assert.throws(() => invoke('execution-complete', f.execution.id), /simplification/);
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

function deadController(f: Awaited<ReturnType<typeof fixture>>): void {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(alive(pid), false);
  f.store.transaction(() => {
    const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
    f.store.releaseLease(f.workspace.id, lease.executionId, lease.runId);
    f.store.acquireLease(f.workspace.id, lease.executionId, lease.runId, { ...lease, controllerPid: pid });
  });
}
function crashDuringInspection(f: Awaited<ReturnType<typeof fixture>>, operation: string): void {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const code = `import {Store} from ${url('store')}; import {Checks} from ${url('checks')}; import {Workspaces} from ${url('workspaces')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    workspaces.inspect = async () => process.exit(0); const checks = new Checks(store, workspaces); ${operation}`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
}

test('completion receipt rejects wrong tokens, partial settlement, process mismatch and live owners', windows, async t => {
  const f = await fixture(t);
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async options => {
    await runCheckProcess(options); throw new Error('Simulated lost final reply');
  });
  assert.equal(check.phase, 'recovery_required');
  assert.throws(() => f.checks.recover(check.id), /controller is still alive/);
  deadController(f);
  const path = join(check.receipt!.directory, 'completion.json'); const original = readFileSync(path, 'utf8');
  const receipt = JSON.parse(original) as Record<string, unknown>;
  for (const mutation of [{ token: 'wrong' }, { checkId: 'wrong' }, { exitConfirmed: false }, { supervisorPid: process.pid }, { toolPid: 0 }]) {
    writeFileSync(path, JSON.stringify({ ...receipt, ...mutation }));
    assert.throws(() => f.checks.recover(check.id), /receipt|Supervisor/); assert.ok(f.store.lease(f.workspace.id));
  }
  writeFileSync(path, original);
  const recovered = f.checks.recover(check.id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(recovered.result?.stdout, 'check passed\n');
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal((await f.checks.run(f.execution.id, await f.spec())).phase, 'passed');
});

test('missing receipt after supervisor death cannot release ownership from dead PIDs alone', windows, async t => {
  const f = await fixture(t); let supervisor = 0;
  const check = await f.checks.run(f.execution.id, await f.spec('setInterval(()=>{},1000)'), undefined, async options => runCheckProcess({ ...options,
    started: (kind, pid) => { options.started(kind, pid); if (kind === 'supervisor') supervisor = pid; else process.kill(supervisor); } }));
  assert.equal(check.phase, 'recovery_required'); deadController(f);
  assert.throws(() => f.checks.recover(check.id), /ENOENT/);
  assert.ok(f.store.lease(f.workspace.id));
});

test('a crash before dispatch is recoverable from durable intent without inventing tool success', async t => {
  const f = await fixture(t); const spec = await f.spec();
  crashDuringInspection(f, `await checks.run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(spec)}, undefined, async () => { throw new Error('Unexpected dispatch'); });`);
  const check = f.store.checks<RepositoryCheck>(f.execution.id).at(-1)!;
  assert.equal(check.dispatch, 'not_requested'); assert.equal(check.receipt, undefined);
  assert.equal(f.checks.recover(check.id).phase, 'interrupted'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('read-only snapshot recovery is fenced and cannot release a command lease', async t => {
  const f = await fixture(t);
  crashDuringInspection(f, `await checks.snapshot(${JSON.stringify(f.execution.id)});`);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  execFileSync(process.execPath, [cli, 'execution-recover', f.execution.id, '--db', f.db], { windowsHide: true, stdio: 'pipe' });
  assert.equal(f.store.lease(f.workspace.id), null); assert.equal(f.workflow.get(f.task.id).phase, 'running');
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => { throw new Error('Unknown tool'); });
  assert.equal(check.phase, 'recovery_required'); deadController(f);
  assert.throws(() => f.executions.recoverReadOnly(f.execution.id), /command and conversation/);
});

test('schema 6 migration preserves legacy uncertainty without inventing recovery evidence', async t => {
  const f = await fixture(t);
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => { throw new Error('Unknown tool'); });
  delete check.dispatch; delete check.receipt; delete check.purpose;
  f.store.saveCheck(check.id, f.execution.id, check); deadController(f);
  const db = new DatabaseSync(f.db); db.exec('PRAGMA user_version = 6'); db.close();
  const migrated = new Store(f.db);
  try { assert.deepEqual(new Checks(migrated).get(check.id), check); assert.throws(() => new Checks(migrated).recover(check.id), /No durable dispatch/); }
  finally { migrated.close(); }
});

const reviewReply: Reply = { kind: 'review', text: 'The supplied greeting matches the brief.', questions: [], findings: [] };
const reviewer = (reply: Reply = reviewReply): Connector => async (_, options) => {
  options.emit({ type: 'session.connected', data: { providerSessionId: 'fixture-review', model: 'fixture-model' } });
  return { turn: async () => ({ status: 'completed', reply, usage: null, error: null }), interrupt: async () => {}, close: async () => {} };
};
async function submitted(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await f.checks.snapshot(f.execution.id);
  f.workflow.finish(f.task.id, f.execution.attemptId, 1, 'succeeded', snapshot.artifact, 'Trusted fixture submission');
  return snapshot;
}

test('artifact review supplies verified files and records independent evidence only after provider shutdown', async t => {
  const f = await fixture(t); const snapshot = await submitted(f);
  const review = await f.executions.create(f.workspace.id, 1, 'claude', 'review');
  const connector: Connector = async (_, options) => ({ turn: async prompt => {
    assert.match(prompt, /console.log\('hello'\)/); assert.match(prompt, /Check the greeting output/); assert.match(prompt, /Print hello/);
    assert.ok(prompt.includes(snapshot.artifact)); assert.ok(f.store.lease(f.workspace.id));
    options.emit({ type: 'session.connected', data: { providerSessionId: 'fixture-review', model: 'fixture-model' } });
    return { status: 'completed', reply: reviewReply, usage: null, error: null };
  }, interrupt: async () => {}, close: async () => {
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped'); assert.ok(f.store.lease(f.workspace.id));
  } });
  const result = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, connector);
  assert.equal(result.status, 'completed');
  const evidence = f.workflow.get(f.task.id).evidence.at(-1)!;
  assert.equal(evidence.kind, 'review'); assert.equal(evidence.outcome, 'passed'); assert.equal(evidence.agent?.sessionId, review.sessionId);
  assert.equal(evidence.artifact, snapshot.artifact); assert.equal(f.store.lease(f.workspace.id), null);
  assert.ok(f.workflow.blockers(f.task.id).includes('verification has not passed'));
});

test('changed artifacts block review dispatch and changes during review cannot pass', async t => {
  const f = await fixture(t); await submitted(f); const review = await f.executions.create(f.workspace.id, 1, 'claude', 'review');
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('changed');\n");
  let called = false;
  const stale = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, async () => { called = true; throw new Error('Unexpected provider'); });
  assert.equal(called, false); assert.equal(stale.status, 'failed'); assert.match(stale.error!, /changed since/);
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('hello');\n");
  const changed = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, async () => ({
    turn: async () => { writeFileSync(join(f.workspace.path!, 'greeting.js'), 'changed during review'); return { status: 'completed', reply: reviewReply, usage: null, error: null }; },
    interrupt: async () => {}, close: async () => {},
  }));
  assert.equal(changed.status, 'failed'); assert.match(changed.error!, /changed during review/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
});

test('blocking findings, questions, and unknown review shutdown cannot leave an older approval current', async t => {
  const f = await fixture(t); await submitted(f);
  const review = await f.executions.create(f.workspace.id, 1, 'codex', 'review', null, 'Fixture alternate provider unavailable');
  await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, reviewer());
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  await runSession(f.store, review.sessionId, 'Review again', { artifactReview: true }, reviewer({ ...reviewReply, findings: [{ severity: 'blocking', description: 'Missing case', evidence: 'greeting.js' }] }));
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
  await runSession(f.store, review.sessionId, 'Review again', { artifactReview: true }, reviewer({ kind: 'question', text: 'Clarify', questions: [{ id: 'format', prompt: 'Which format?', choices: [] }], findings: [] }));
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await runSession(f.store, review.sessionId, '', { artifactReview: true, answers: { format: 'text' } }, reviewer());
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  const unknown: Connector = async () => ({ turn: async () => ({ status: 'completed', reply: reviewReply, usage: null, error: null }), interrupt: async () => {}, close: async () => { throw new Error('Unknown exit'); } });
  await runSession(f.store, review.sessionId, 'Review again', { artifactReview: true }, unknown);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped'); assert.ok(f.store.lease(f.workspace.id));
});

test('verification requires exact criteria and observed output; a newer failure supersedes a pass', windows, async t => {
  const f = await fixture(t); await submitted(f);
  const spec = { ...await f.spec("console.log('hello')"), criteria: ['Print hello'], expectedStdout: 'hello\n' };
  await assert.rejects(f.checks.run(f.execution.id, { ...spec, criteria: ['Unknown criterion'] }), /exact mapping/);
  assert.deepEqual(f.store.checks(f.execution.id), []);
  const passed = await f.checks.run(f.execution.id, spec); assert.equal(passed.phase, 'passed');
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.kind, 'verification'); assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  const wrong = await f.checks.run(f.execution.id, { ...spec, args: ['-e', "console.log('wrong')"] });
  assert.equal(wrong.result?.exitCode, 0); assert.equal(wrong.phase, 'failed'); assert.match(wrong.error!, /expectedStdout/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
  const unavailable = await f.checks.run(f.execution.id, { ...spec, args: ['-e', "setTimeout(()=>console.log('lost output'),100)"], expectedStdout: '' }, undefined,
    async options => {
      const result = await runCheckProcess(options);
      rmSync(join(options.receipt!.directory, 'stdout'));
      return { ...result, ...retainedOutput(options.receipt!.directory) };
    });
  assert.equal(unavailable.result?.exitCode, 0); assert.equal(unavailable.phase, 'failed'); assert.equal(unavailable.result?.outputUnavailable, true);
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('changed');\n");
  const newer = { ...await f.spec("console.log('hello')"), criteria: spec.criteria, expectedStdout: spec.expectedStdout };
  const stale = await f.checks.run(f.execution.id, newer);
  assert.equal(stale.phase, 'failed'); assert.equal(stale.dispatch, 'not_requested'); assert.match(stale.error!, /changed since implementation/);
});

test('verification crash recovery records skipped evidence and cannot resurrect an earlier passing gate', windows, async t => {
  const f = await fixture(t); await submitted(f);
  const spec = { ...await f.spec("console.log('hello')"), criteria: ['Print hello'], expectedStdout: 'hello\n' };
  await f.checks.run(f.execution.id, spec);
  const lost = await f.checks.run(f.execution.id, spec, undefined, async options => { await runCheckProcess(options); throw new Error('Lost reply'); });
  assert.equal(lost.phase, 'recovery_required'); assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  deadController(f); f.checks.recover(lost.id);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification'); assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
});

test('completion checks every gate and revalidates artifact before the final transaction', windows, async t => {
  const f = await fixture(t); const validation = await f.checks.run(f.execution.id, await f.spec()); await f.checks.finish(f.execution.id, validation.id);
  const review = await f.executions.create(f.workspace.id, 1, 'claude', 'review');
  await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, reviewer());
  const spec = { ...await f.spec("console.log('hello')"), criteria: ['Print hello'], expectedStdout: 'hello\n' };
  await f.checks.run(f.execution.id, spec);
  await assert.rejects(f.checks.complete(f.execution.id), /simplification/);
  await f.checks.simplify(f.execution.id, { artifact: spec.artifact, instructionsDigest: spec.instructionsDigest,
    outcome: 'passed', summary: 'Explicit fixture assessment of the one-line implementation' });
  writeFileSync(join(f.workspace.path!, 'extra.txt'), 'after evidence');
  await assert.rejects(f.checks.complete(f.execution.id), /changed since/); assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  rmSync(join(f.workspace.path!, 'extra.txt'));
  await f.checks.complete(f.execution.id); assert.equal(f.workflow.get(f.task.id).phase, 'complete'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('explicit simplification records all outcomes, rejects stale inputs and supersedes older passes', async t => {
  const f = await fixture(t); const snapshot = await f.checks.snapshot(f.execution.id);
  const assessment = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, outcome: 'passed' as const,
    summary: 'One direct output statement; no duplication or unnecessary abstractions; output assertion exercises the requirement.' };
  await assert.rejects(f.checks.simplify(f.execution.id, assessment), /submitted/);
  await submitted(f);
  await assert.rejects(f.checks.simplify(f.execution.id, { ...assessment, summary: ' ' }), /nonempty/);
  await f.checks.simplify(f.execution.id, assessment);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  await assert.rejects(f.checks.simplify(f.execution.id, { ...assessment, instructionsDigest: '0'.repeat(64) }), /changed/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await f.checks.simplify(f.execution.id, assessment);
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('changed');\n");
  await assert.rejects(f.checks.simplify(f.execution.id, assessment), /changed/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('hello');\n");
  for (const outcome of ['failed', 'skipped'] as const) {
    await f.checks.simplify(f.execution.id, { ...assessment, outcome });
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, outcome);
    assert.ok(f.workflow.blockers(f.task.id).some(item => item.includes('simplification')));
  }
  const review = await f.executions.create(f.workspace.id, 1, 'claude', 'review');
  await assert.rejects(f.checks.simplify(review.id, assessment), /implementation execution/);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('simplification CLI persists assessment and crashed reassessment recovers without restoring a pass', async t => {
  const f = await fixture(t); const snapshot = await submitted(f);
  const assessment = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, outcome: 'passed', summary: 'Direct greeting with useful output coverage.' };
  const specFile = join(f.root, 'simplification.json'); writeFileSync(specFile, JSON.stringify(assessment));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  execFileSync(process.execPath, [cli, 'execution-simplify', f.execution.id, specFile, '--db', f.db], { windowsHide: true, stdio: 'pipe' });
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  crashDuringInspection(f, `await checks.simplify(${JSON.stringify(f.execution.id)}, ${JSON.stringify(assessment)});`);
  assert.equal(f.store.lease<ExecutionLease>(f.workspace.id)?.kind, 'simplification');
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  f.executions.recoverReadOnly(f.execution.id);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await f.checks.simplify(f.execution.id, assessment as Parameters<Checks['simplify']>[1]);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
});
