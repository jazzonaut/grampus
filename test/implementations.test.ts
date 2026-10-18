import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync, existsSync } from 'node:fs';
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
import { authorizeEditTool, authorizeFileChanges, deleteEditingFile, deleteFileTool, editingFileContext, prepareEditing, validateEditPolicy, verifyEditingScope, type EditPolicy } from '../src/edit-policy.js';
import { snapshotRepository } from '../src/artifacts.js';
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
  const policy: EditPolicy = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: ['greeting.js'] };
  const context = { cwd: workspace.path!, policy, snapshot };
  return { root, repo, db, store, workflow, task, workspace, execution, checks, snapshot, policy, context, implementations: new Implementations(store) };
}
function fakeResult(options: CheckProcessOptions, value = reply) {
  writeFileSync(join(options.receipt!.directory, 'result.json'), JSON.stringify({ id: options.receipt!.checkId,
    result: { status: 'completed', reply: value, usage: null, error: null } }));
  return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}

test('native implementation defaults to an unlimited supervised turn', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    assert.equal(options.timeoutMs, 0);
    return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.result?.error ?? run.error ?? '');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('unlimited native supervision completes normally and still supports explicit stop', windows, async () => {
  const completed = await runCheckProcess({ file: process.execPath, args: ['-e', 'setTimeout(()=>console.log("done"),22_000)'],
    cwd: process.cwd(), timeoutMs: 0, started: () => {} });
  assert.equal(completed.reason, 'exited'); assert.equal(completed.exitConfirmed, true);
  assert.equal(completed.stdout.trim(), 'done');
  const abort = new AbortController();
  const stopped = await runCheckProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(), timeoutMs: 0, signal: abort.signal,
    started: kind => { if (kind === 'tool') setTimeout(() => abort.abort(), 200); } });
  assert.equal(stopped.reason, 'interrupted'); assert.equal(stopped.exitConfirmed, true);
});

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

test('explicit creation supports Claude Write followed by Read/Edit and Codex add followed by update', async t => {
  const f = await fixture(t); f.policy.create = ['new.txt']; prepareEditing(f.context);
  const events: string[] = [];
  const authorize = (name: string, input: unknown) => authorizeEditTool(f.context, name, input, event => events.push(event.type)).allowed;
  const add = { path: 'new.txt', kind: { type: 'add' }, diff: '+created\n' };
  assert.deepEqual(JSON.parse(editingFileContext(f.context)).at(-1), { path: 'new.txt', content: null });
  assert.equal(authorize('Read', { file_path: 'new.txt' }), false);
  assert.equal(authorize('Edit', { file_path: 'new.txt', old_string: '', new_string: 'created' }), false);
  assert.equal(authorize('Write', { file_path: 'new.txt', content: 'created\n' }), true);
  assert.equal(authorizeFileChanges(f.context, [add], event => events.push(event.type)), true);
  assert.equal(authorizeFileChanges(f.context, [add], () => { throw new Error('Journal unavailable'); }), false);
  assert.equal(authorize('Write', { file_path: 'new.txt', content: 'created' }), true);
  assert.equal(authorizeEditTool(f.context, 'Write', { file_path: 'new.txt', content: 'created' }, () => { throw new Error('Journal unavailable'); }).allowed, false);
  writeFileSync(join(f.workspace.path!, 'new.txt'), 'created\n');
  assert.equal(authorize('Read', { file_path: 'new.txt' }), true);
  assert.equal(authorize('Edit', { file_path: 'new.txt', old_string: 'created', new_string: 'updated' }), true);
  assert.equal(authorizeFileChanges(f.context, [add], () => {}), false);
  assert.equal(authorizeFileChanges(f.context, [{ ...add, kind: { type: 'update' }, diff: '-created\n+updated' }], () => {}), true);
  assert.equal(authorizeFileChanges(f.context, [{ ...add, kind: { type: 'delete' } }], () => {}), false);
  verifyEditingScope(f.context, await snapshotRepository(f.workspace.path!, f.workspace.baseCommit));
  assert.ok(events.includes('tool.authorized') && events.includes('tool.denied'));
});

test('creation policies reject overlaps, controls, aliases and paths without existing parents', async t => {
  const f = await fixture(t);
  for (const create of [['greeting.js'], ['AGENTS.md'], ['nested/CLAUDE.md'], ['.codex/new.txt'], ['../outside'], ['NUL.txt'], ['new?.txt'], ['a.txt', 'a.txt']]) {
    assert.throws(() => validateEditPolicy({ ...f.policy, create }));
  }
  if (process.platform === 'win32') assert.throws(() => validateEditPolicy({ ...f.policy, create: ['GREETING.js'] }));
  assert.throws(() => validateEditPolicy({ ...f.policy, create: Array.from({ length: 64 }, (_, i) => `${i}.txt`) }));
  assert.throws(() => validateEditPolicy({ ...f.policy, create: null } as unknown as EditPolicy));
  validateEditPolicy({ ...f.policy, files: [], create: ['new.txt'] });
  for (const path of ['other.txt', 'missing/new.txt', 'greeting.js/new.txt']) {
    assert.throws(() => prepareEditing({ ...f.context, policy: { ...f.policy, create: [path] } }));
  }
  mkdirSync(join(f.root, 'outside'));
  symlinkSync(join(f.root, 'outside'), join(f.workspace.path!, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const context = { ...f.context, policy: { ...f.policy, create: ['alias/new.txt'] } };
  assert.throws(() => prepareEditing(context), /without links/);
  assert.equal(authorizeEditTool(context, 'Write', { file_path: 'alias/new.txt', content: 'escape' }, () => {}).allowed, false);
});

test('creation refuses ignored paths and previously deleted tracked paths', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path!, '.gitignore'), '*.cache\n');
  rmSync(join(f.workspace.path!, 'other.txt'));
  const snapshot = await f.checks.snapshot(f.execution.id);
  const policy = { ...f.policy, artifact: snapshot.artifact, create: ['new.cache'] };
  assert.throws(() => prepareEditing({ ...f.context, snapshot, policy }), /not ignored/);
  assert.throws(() => prepareEditing({ ...f.context, snapshot, policy: { ...policy, create: ['other.txt'] } }), /absent from the snapshot/);
  assert.equal(authorizeEditTool({ ...f.context, snapshot, policy }, 'Write', { file_path: 'new.cache', content: 'ignored' }, () => {}).allowed, false);
  assert.equal(authorizeFileChanges({ ...f.context, snapshot, policy }, [{ path: 'new.cache', kind: { type: 'add' }, diff: '+ignored' }], () => {}), false);
});

test('created files must remain bounded unlinked text and visible in the final snapshot', async t => {
  const f = await fixture(t); f.policy.create = ['new.txt']; prepareEditing(f.context);
  const path = join(f.workspace.path!, 'new.txt');
  for (const content of [Buffer.from([0, 255]), Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    writeFileSync(path, content);
    assert.throws(() => verifyEditingScope(f.context, { ...f.snapshot, files: [...f.snapshot.files, { path: 'new.txt', sha256: 'fixture', executable: false }] }), /text|bounded/);
  }
  writeFileSync(path, 'created'); linkSync(path, join(f.root, 'hardlink'));
  assert.equal(authorizeEditTool(f.context, 'Write', { file_path: 'new.txt', content: 'rewrite' }, () => {}).allowed, false);
  rmSync(join(f.root, 'hardlink'));
  assert.throws(() => verifyEditingScope(f.context, f.snapshot), /missing from repository snapshot/);
  writeFileSync(join(f.workspace.path!, 'unauthorized.txt'), 'outside scope');
  const after = await snapshotRepository(f.workspace.path!, f.workspace.baseCommit);
  assert.throws(() => verifyEditingScope(f.context, after), /outside the explicit creation policy/);
});

test('deletion policy validates distinct existing targets and current snapshot bytes', async t => {
  const f = await fixture(t); f.policy.delete = ['other.txt']; prepareEditing(f.context);
  assert.deepEqual(JSON.parse(editingFileContext(f.context)).at(-1), { path: 'other.txt', content: 'unchanged\n' });
  validateEditPolicy({ ...f.policy, files: [] });
  for (const value of [{ ...f.policy, delete: ['greeting.js'] }, { ...f.policy, create: ['other.txt'] },
    { ...f.policy, delete: ['AGENTS.md'] }, { ...f.policy, delete: ['../outside'] },
    { ...f.policy, delete: ['other.txt', 'other.txt'] }, { ...f.policy, delete: null }]) {
    assert.throws(() => validateEditPolicy(value as EditPolicy));
  }
  if (process.platform === 'win32') assert.throws(() => validateEditPolicy({ ...f.policy, delete: ['GREETING.js'] }));
  assert.throws(() => validateEditPolicy({ ...f.policy, create: Array.from({ length: 63 }, (_, i) => `${i}.txt`) }));
  assert.throws(() => prepareEditing({ ...f.context, policy: { ...f.policy, delete: ['missing.txt'] } }));
  writeFileSync(join(f.workspace.path!, 'other.txt'), 'changed after snapshot');
  assert.throws(() => prepareEditing(f.context), /unchanged snapshot bytes/);
});

test('scoped unlink journals permission first, forbids other writes and cannot repeat a deletion', async t => {
  const f = await fixture(t); f.policy.delete = ['other.txt']; prepareEditing(f.context);
  const path = join(f.workspace.path!, 'other.txt'); const events: string[] = [];
  assert.equal(authorizeEditTool(f.context, 'Read', { file_path: path }, () => {}).allowed, true);
  for (const [tool, input] of [['Write', { file_path: path, content: '' }],
    ['Edit', { file_path: path, old_string: 'unchanged', new_string: '' }],
    [deleteFileTool, { file_path: 'greeting.js' }], [deleteFileTool, { file_path: path, recursive: true }]] as const) {
    assert.equal(authorizeEditTool(f.context, tool, input, () => {}).allowed, false);
  }
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => { throw new Error('Journal unavailable'); }), /Journal unavailable/);
  assert.equal(existsSync(path), true);
  deleteEditingFile(f.context, { file_path: path }, event => {
    if (event.type === 'tool.authorized') assert.equal(existsSync(path), true);
    if (event.type === 'tool.deleted') assert.equal(existsSync(path), false);
    events.push(event.type);
  });
  assert.deepEqual(events, ['tool.authorized', 'tool.deleted']);
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}));
  assert.equal(authorizeEditTool(f.context, 'Write', { file_path: path, content: 'recreated' }, () => {}).allowed, false);
  const after = await snapshotRepository(f.workspace.path!, f.workspace.baseCommit);
  verifyEditingScope(f.context, after);
  assert.ok(after.diff.some(file => file.path === 'other.txt' && file.after === null && file.previousContent === 'unchanged\n'));
});

test('deletion refuses changed bytes, links and directories at the actual unlink boundary', async t => {
  const f = await fixture(t); f.policy.delete = ['other.txt']; const path = join(f.workspace.path!, 'other.txt');
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, event => {
    if (event.type === 'tool.authorized') writeFileSync(path, 'changed during permission journaling');
  }), /unchanged snapshot bytes/);
  assert.equal(readFileSync(path, 'utf8'), 'changed during permission journaling');
  writeFileSync(path, 'unchanged\n'); linkSync(path, join(f.root, 'hardlink'));
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}), /without links/);
  rmSync(join(f.root, 'hardlink')); rmSync(path); mkdirSync(path);
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}), /regular text files/);
});

test('deletion-only scope handles empty untracked files and permits unchanged optional targets', async t => {
  const f = await fixture(t); writeFileSync(join(f.workspace.path!, 'empty.txt'), '');
  const snapshot = await f.checks.snapshot(f.execution.id);
  const context = { ...f.context, snapshot, policy: { ...f.policy, artifact: snapshot.artifact, files: [], delete: ['empty.txt', 'other.txt'] } };
  prepareEditing(context); verifyEditingScope(context, snapshot);
  deleteEditingFile(context, { file_path: 'empty.txt' }, () => {});
  const after = await snapshotRepository(f.workspace.path!, f.workspace.baseCommit);
  assert.ok(!after.files.some(file => file.path === 'empty.txt'));
  assert.equal(readFileSync(join(f.workspace.path!, 'other.txt'), 'utf8'), 'unchanged\n');
  verifyEditingScope(context, after);
});

test('Codex delete approvals reject updates, moves, mixed unauthorized paths and stale target bytes', async t => {
  const f = await fixture(t, 'codex'); f.policy.delete = ['other.txt'];
  const deletion = { path: 'other.txt', kind: { type: 'delete' }, diff: '-unchanged\n' };
  assert.equal(authorizeFileChanges(f.context, [deletion], () => {}), true);
  for (const changes of [[deletion, deletion], [deletion, { ...deletion, path: 'greeting.js' }],
    [{ ...deletion, kind: { type: 'update' } }], [{ ...deletion, kind: { type: 'add' } }],
    [{ ...deletion, kind: { type: 'delete', move_path: null } }]]) {
    assert.equal(authorizeFileChanges(f.context, changes, () => {}), false);
  }
  assert.equal(authorizeFileChanges(f.context, [deletion], () => { throw new Error('Journal unavailable'); }), false);
  writeFileSync(join(f.workspace.path!, 'other.txt'), 'changed');
  assert.equal(authorizeFileChanges(f.context, [deletion], () => {}), false);
  const after = await snapshotRepository(f.workspace.path!, f.workspace.baseCommit);
  assert.throws(() => verifyEditingScope(f.context, after), /outside the explicit/);
});

for (const provider of ['claude', 'codex'] as const) test(`${provider} deletion settles with retained removed bytes and no completion evidence`, windows, async t => {
  const f = await fixture(t, provider); f.policy.files = []; f.policy.delete = ['other.txt'];
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    deleteEditingFile(f.context, { file_path: 'other.txt' }, () => {}); return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.error ?? undefined);
  assert.ok(run.after?.diff.some(file => file.path === 'other.txt' && file.after === null && file.previousContent === 'unchanged\n'));
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
});

for (const provider of ['claude', 'codex'] as const) test(`${provider} creation settles with a snapshot and leaves completion gates outstanding`, windows, async t => {
  const f = await fixture(t, provider); f.policy.files = []; f.policy.create = ['new.txt'];
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    writeFileSync(join(f.workspace.path!, 'new.txt'), 'created\n'); return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.error ?? undefined);
  assert.deepEqual(run.policy.create, ['new.txt']);
  assert.ok(run.after?.diff.some(file => file.path === 'new.txt' && file.before === null && file.content === 'created\n'));
  assert.equal(f.workflow.get(f.task.id).phase, 'running'); assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('unauthorized additions and removal of writable files fail native settlement', windows, async t => {
  for (const removal of [false, true]) {
    const f = await fixture(t); f.policy.create = ['new.txt'];
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      writeFileSync(join(f.workspace.path!, 'new.txt'), 'authorized');
      if (removal) rmSync(join(f.workspace.path!, 'greeting.js'));
      else writeFileSync(join(f.workspace.path!, 'outside.txt'), 'unauthorized');
      return fakeResult(options);
    });
    assert.equal(run.phase, 'failed'); assert.match(run.error!, /outside the explicit/);
    assert.equal(readFileSync(join(f.workspace.path!, 'new.txt'), 'utf8'), 'authorized');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
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

function crashCode(f: Awaited<ReturnType<typeof fixture>>, before: boolean, target = 'greeting.js', remove = false): string {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  return `import {Store} from ${url('store')}; import {Implementations} from ${url('implementations')}; import {Workspaces} from ${url('workspaces')};
    import {runCheckProcess} from ${url('check-process')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    ${before ? 'workspaces.inspect = async () => process.exit(0);' : ''}
    await new Implementations(store, workspaces).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(f.policy)}, undefined, {},
      async options => runCheckProcess({...options,args:['-e',${JSON.stringify(`require('node:fs').${remove ? `unlinkSync(${JSON.stringify(target)})` : `writeFileSync(${JSON.stringify(target)},"console.log('partial');\\n")`};setTimeout(()=>{},30000)`)}]}));`;
}

for (const target of ['greeting.js', 'new.txt', 'other.txt']) test(`actual controller death preserves partial ${target} change through receipt recovery without replay`, windows, async t => {
  const f = await fixture(t);
  const removal = target === 'other.txt';
  if (target === 'new.txt') f.policy.create = [target];
  if (removal) f.policy.delete = [target];
  const controller = execFile(process.execPath, ['--input-type=module', '-e', crashCode(f, false, target, removal)], { windowsHide: true }); controller.stdin?.end();
  const closed = new Promise<void>(resolve => controller.once('close', () => resolve()));
  t.after(() => { try { controller.kill(); } catch {} });
  const waitFor = async (condition: () => boolean) => { const deadline = Date.now() + 15000; while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture wait timed out'); await delay(50); } };
  await waitFor(() => removal ? !existsSync(join(f.workspace.path!, target)) : existsSync(join(f.workspace.path!, target)) && readFileSync(join(f.workspace.path!, target), 'utf8').includes('partial'));
  controller.kill(); await closed;
  const run = f.store.implementations<ImplementationRun>(f.execution.id).at(-1)!;
  await waitFor(() => existsSync(join(run.receipt!.directory, 'completion.json')));
  await waitFor(() => { try { process.kill(run.supervisorPid!, 0); return false; } catch { return true; } });
  const recovered = await f.implementations.recover(run.id);
  assert.equal(recovered.phase, 'interrupted'); assert.equal(f.workflow.get(f.task.id).phase, 'stopped');
  if (removal) assert.equal(existsSync(join(f.workspace.path!, target)), false);
  else assert.match(readFileSync(join(f.workspace.path!, target), 'utf8'), /partial/);
  assert.equal(git(f.workspace.path!, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.store.implementations(f.execution.id).length, 1);
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
