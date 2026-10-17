import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Workspaces } from '../src/workspaces.js';
import { Executions } from '../src/executions.js';
import { Sessions, runSession } from '../src/sessions.js';
import { Checks } from '../src/checks.js';
import { Implementations, type ImplementationRun } from '../src/implementations.js';
import { authorizeEditTool, authorizeFileChanges, editingFileContext, prepareEditing, validateEditPolicy } from '../src/edit-policy.js';
import { runCheckProcess, type CheckProcessOptions } from '../src/check-process.js';
import type { ExecutionLease } from '../src/execution-state.js';
import type { Reply } from '../src/agents/types.js';

const windows = { skip: process.platform !== 'win32' };
const reply: Reply = { kind: 'message', text: 'Fixture edit complete', questions: [], findings: [] };
function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim(); }
async function fixture(t: { after(fn: () => void): void }, provider: 'claude' | 'codex' = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'grampus-edit-test-')); const repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n"); writeFileSync(join(repo, 'other.txt'), 'unchanged\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Use one direct output statement.\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Baseline');
  const db = join(root, 'journal.sqlite'); const store = new Store(db);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workflow = new Workflow(store); const task = workflow.create({ title: 'Greeting', outcome: 'Print hello world', criteria: ['Print hello world'], plan: 'Edit greeting, check and review' });
  workflow.approve(task.id, 1); const workspace = await new Workspaces(store).create(task.id, 1, repo, join(root, 'workspace'));
  const execution = await new Executions(store).create(workspace.id, 1, provider); const checks = new Checks(store);
  const snapshot = await checks.snapshot(execution.id);
  const policy = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: ['greeting.js'] };
  const context = { cwd: workspace.path!, policy, snapshot };
  return { root, repo, db, store, workflow, task, workspace, execution, checks, snapshot, policy, context, implementations: new Implementations(store) };
}
function fakeResult(options: CheckProcessOptions, value = reply) {
  writeFileSync(join(options.receipt!.directory, 'result.json'), JSON.stringify({ id: options.receipt!.checkId,
    result: { status: 'completed', reply: value, usage: null, error: null } }));
  return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}

test('file policy allows only existing text paths and validates structured output without permitting other tools', async t => {
  const f = await fixture(t); prepareEditing(f.context); const events: string[] = [];
  const authorize = (tool: string, input: unknown) => authorizeEditTool(f.context, tool, input, event => events.push(event.type));
  assert.equal(authorize('Read', { file_path: join(f.workspace.path!, 'other.txt') }).allowed, true);
  assert.equal(authorize('Edit', { file_path: 'greeting.js', old_string: 'hello', new_string: 'hello world' }).allowed, true);
  assert.equal(authorize('Write', { file_path: 'greeting.js', content: 'replacement' }).allowed, true);
  for (const path of ['other.txt', '../outside.txt', '.git/config', 'AGENTS.md', 'missing.txt', 'greeting.js:stream']) assert.equal(authorize('Write', { file_path: path, content: 'denied' }).allowed, false);
  for (const name of ['Bash', 'Agent', 'WebFetch', 'mcp__fixture', 'NotebookEdit']) assert.equal(authorize(name, { file_path: 'greeting.js' }).allowed, false);
  assert.equal(authorize('StructuredOutput', reply).allowed, true);
  assert.equal(authorize('StructuredOutput', { kind: 'bad' }).allowed, false);
  assert.ok(events.includes('tool.authorized') && events.includes('tool.denied'));
});

test('file policy rejects links, oversized/binary input, stale acknowledgement and failed decision journaling', async t => {
  const f = await fixture(t);
  for (const path of ['../escape', 'AGENTS.md', 'a/../b', '.git/config', 'foo.', 'a\\b']) assert.throws(() => validateEditPolicy({ ...f.policy, files: [path] }));
  assert.throws(() => prepareEditing({ ...f.context, policy: { ...f.policy, instructionsDigest: '0'.repeat(64) } }), /no longer matches/);
  assert.equal(authorizeEditTool(f.context, 'Read', { file_path: 'greeting.js' }, () => { throw new Error('Journal unavailable'); }).allowed, false);
  assert.equal(authorizeEditTool(f.context, 'Write', { file_path: 'greeting.js', content: '\0' }, () => {}).allowed, false);
  assert.equal(authorizeEditTool(f.context, 'Write', { file_path: 'greeting.js', content: 'a'.repeat(256 * 1024 + 1) }, () => {}).allowed, false);
  linkSync(join(f.workspace.path!, 'greeting.js'), join(f.root, 'alias'));
  assert.throws(() => prepareEditing(f.context), /without links/);
});

test('native fixture editing records before/after content and keeps every completion gate outstanding', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    assert.equal(f.store.lease<ExecutionLease>(f.workspace.id)?.kind, 'implementation');
    assert.equal(f.store.implementations<ImplementationRun>(f.execution.id).at(-1)?.dispatch, 'requested');
    writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('hello world');\n"); return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.error ?? undefined); assert.notEqual(run.before?.artifact, run.after?.artifact);
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
  await assert.rejects(runSession(f.store, f.execution.sessionId, 'Ordinary conversation'), /execution-implement/);
});

test('out-of-scope writes cannot become a successful implementation reply', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    writeFileSync(join(f.workspace.path!, 'other.txt'), 'unauthorized'); return fakeResult(options);
  });
  assert.equal(run.phase, 'failed'); assert.match(run.error!, /outside the explicit/);
  assert.equal(f.workflow.get(f.task.id).phase, 'failed'); assert.equal(readFileSync(join(f.workspace.path!, 'other.txt'), 'utf8'), 'unauthorized');
});

test('stale policies refuse dispatch and conversation sessions cannot acquire editing leases', windows, async t => {
  const f = await fixture(t); let called = false; writeFileSync(join(f.workspace.path!, 'other.txt'), 'new content');
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => { called = true; return fakeResult(options); });
  assert.equal(called, false); assert.equal(run.dispatch, 'not_requested'); assert.equal(run.phase, 'failed');
  const g = await fixture(t, 'codex');
  const session = new Sessions(g.store).get(g.execution.sessionId); session.providerSessionId = 'conversation-thread'; g.store.saveSession(session.id, session);
  await assert.rejects(g.implementations.run(g.execution.id, g.policy), /fresh session/);
  assert.equal(g.store.lease(g.workspace.id), null); assert.deepEqual(g.store.implementations(g.execution.id), []);
});

test('Codex patch policy validates the whole change set and fails closed on journal errors', async t => {
  const f = await fixture(t, 'codex');
  const update = { path: 'greeting.js', kind: { type: 'update', move_path: null }, diff: '-hello\n+hello world' };
  const authorize = (changes: unknown) => authorizeFileChanges(f.context, changes, () => {});
  assert.equal(authorize([update]), true);
  for (const changes of [[], [update, { ...update, path: 'other.txt' }], [update, update],
    [{ ...update, path: '../outside' }], [{ ...update, path: 'AGENTS.md' }],
    [{ ...update, kind: { type: 'add' } }], [{ ...update, kind: { type: 'delete' } }],
    [{ ...update, kind: { type: 'update', move_path: 'other.txt' } }],
    [{ ...update, kind: { type: 'update', movePath: 'other.txt' } }],
    [{ ...update, diff: '\0' }], [{ ...update, diff: 'a'.repeat(256 * 1024 + 1) }]]) assert.equal(authorize(changes), false);
  assert.equal(authorizeFileChanges(f.context, [update], () => { throw new Error('Journal unavailable'); }), false);
  assert.deepEqual(JSON.parse(editingFileContext(f.context)), [{ path: 'greeting.js', content: "console.log('hello');\n" }]);
});

test('fresh Codex implementation uses the shared supervised editing lease and settlement', windows, async t => {
  const f = await fixture(t, 'codex');
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    assert.equal(new Sessions(f.store).get(f.execution.sessionId).mode, 'editing');
    assert.equal(f.store.lease<ExecutionLease>(f.workspace.id)?.kind, 'implementation');
    writeFileSync(join(f.workspace.path!, 'greeting.js'), "console.log('hello world');\n"); return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.error ?? undefined);
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.equal(f.store.lease(f.workspace.id), null);
});

test('native questions resume only with complete answers and a newly acknowledged policy', windows, async t => {
  const f = await fixture(t);
  await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => fakeResult(options,
    { kind: 'question', text: 'Choose greeting', questions: [{ id: 'greeting', prompt: 'Which greeting?', choices: ['hello world'] }], findings: [] }));
  assert.equal(new Sessions(f.store).get(f.execution.sessionId).phase, 'awaiting_answer');
  await assert.rejects(f.implementations.run(f.execution.id, f.policy), /Answer every pending/);
  const resumed = await f.implementations.run(f.execution.id, f.policy, undefined, { answers: { greeting: 'hello world' } }, async options => {
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string }; assert.match(request.prompt, /hello world/); return fakeResult(options);
  });
  assert.equal(resumed.phase, 'completed');
});

test('unknown native shutdown retains ownership and cannot use PID-only conversation recovery', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async () => { throw new Error('Lost supervisor'); });
  assert.equal(run.phase, 'recovery_required'); assert.equal(f.workflow.get(f.task.id).phase, 'recovery_required');
  assert.throws(() => new Sessions(f.store).recover(f.execution.sessionId, () => false), /implementation-recover/);
  assert.throws(() => new Executions(f.store).recoverReadOnly(f.execution.id), /No recoverable read-only/);
  await assert.rejects(f.implementations.recover(run.id), /controller is still alive/);
  assert.ok(f.store.lease(f.workspace.id));
});

function crashCode(f: Awaited<ReturnType<typeof fixture>>, before: boolean): string {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  return `import {Store} from ${url('store')}; import {Implementations} from ${url('implementations')}; import {Workspaces} from ${url('workspaces')};
    import {runCheckProcess} from ${url('check-process')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    ${before ? 'workspaces.inspect = async () => process.exit(0);' : ''}
    await new Implementations(store, workspaces).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(f.policy)}, undefined, {},
      async options => runCheckProcess({...options,args:['-e',${JSON.stringify(`require('node:fs').writeFileSync('greeting.js',"console.log('partial');\\n");setTimeout(()=>{},30000)`)}]}));`;
}

test('actual controller death stops native fixture tools and receipt recovery preserves edits without replay', windows, async t => {
  const f = await fixture(t);
  const controller = execFile(process.execPath, ['--input-type=module', '-e', crashCode(f, false)], { windowsHide: true }); controller.stdin?.end();
  const closed = new Promise<void>(resolve => controller.once('close', () => resolve()));
  t.after(() => { try { controller.kill(); } catch {} });
  const waitFor = async (condition: () => boolean) => { const deadline = Date.now() + 15000; while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture wait timed out'); await delay(50); } };
  await waitFor(() => readFileSync(join(f.workspace.path!, 'greeting.js'), 'utf8').includes('partial'));
  controller.kill(); await closed;
  const run = f.store.implementations<ImplementationRun>(f.execution.id).at(-1)!;
  await waitFor(() => existsSync(join(run.receipt!.directory, 'completion.json')));
  await waitFor(() => { try { process.kill(run.supervisorPid!, 0); return false; } catch { return true; } });
  const recovered = await f.implementations.recover(run.id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(f.workflow.get(f.task.id).phase, 'stopped');
  assert.match(readFileSync(join(f.workspace.path!, 'greeting.js'), 'utf8'), /partial/);
  assert.equal(f.store.lease(f.workspace.id), null);
  await assert.rejects(f.implementations.run(f.execution.id, f.policy), /settled/);
});

test('native recovery before dispatch invokes no tools and marks the attempt stopped', windows, async t => {
  const f = await fixture(t); execFileSync(process.execPath, ['--input-type=module', '-e', crashCode(f, true)], { windowsHide: true, stdio: 'pipe' });
  const pending = f.store.implementations<ImplementationRun>(f.execution.id).at(-1)!;
  assert.equal(pending.dispatch, 'not_requested');
  const recovered = await f.implementations.recover(pending.id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(f.workflow.get(f.task.id).phase, 'stopped');
});

test('schema 8 migration preserves sessions and adds implementation storage', windows, async t => {
  const f = await fixture(t); const db = new DatabaseSync(f.db); db.exec('DROP TABLE implementations; PRAGMA user_version = 8'); db.close();
  const migrated = new Store(f.db);
  try { assert.deepEqual(migrated.implementations(f.execution.id), []); assert.equal(new Sessions(migrated).get(f.execution.sessionId).provider, 'claude'); }
  finally { migrated.close(); }
});
