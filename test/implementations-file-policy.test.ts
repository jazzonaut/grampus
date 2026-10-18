// Implementation tests: file, creation and deletion policies and their native settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorizeEditTool,
  authorizeFileChanges,
  deleteEditingFile,
  deleteFileTool,
  editingFileContext,
  prepareEditing,
  validateEditPolicy,
  verifyEditingScope,
  type EditPolicy,
} from '../src/edit-policy.js';
import { snapshotRepository } from '../src/artifacts.js';
import { windows, reply, fixture, fakeResult } from './helpers/implementations.js';

test('file policy allows only existing text paths and validates structured output without permitting other tools', async t => {
  const f = await fixture(t);
  prepareEditing(f.context);
  const events: string[] = [];
  const authorize = (tool: string, input: unknown) =>
    authorizeEditTool(f.context, tool, input, event => events.push(event.type));
  assert.equal(authorize('Read', { file_path: join(f.workspace.path, 'other.txt') }).allowed, true);
  assert.equal(
    authorize('Edit', { file_path: 'greeting.js', old_string: 'hello', new_string: 'hello world' }).allowed,
    true,
  );
  assert.equal(authorize('Write', { file_path: 'greeting.js', content: 'replacement' }).allowed, true);
  for (const path of ['other.txt', '../outside.txt', '.git/config', 'AGENTS.md', 'missing.txt', 'greeting.js:stream'])
    assert.equal(authorize('Write', { file_path: path, content: 'denied' }).allowed, false);
  for (const name of ['Bash', 'Agent', 'WebFetch', 'mcp__fixture', 'NotebookEdit'])
    assert.equal(authorize(name, { file_path: 'greeting.js' }).allowed, false);
  assert.equal(authorize('StructuredOutput', reply).allowed, true);
  assert.equal(authorize('StructuredOutput', { kind: 'bad' }).allowed, false);
  assert.ok(events.includes('tool.authorized') && events.includes('tool.denied'));
});

test('file policy rejects links, oversized/binary input, stale acknowledgement and failed decision journaling', async t => {
  const f = await fixture(t);
  for (const path of ['../escape', 'AGENTS.md', 'a/../b', '.git/config', 'foo.', 'a\\b'])
    assert.throws(() => validateEditPolicy({ ...f.policy, files: [path] }));
  assert.throws(
    () => prepareEditing({ ...f.context, policy: { ...f.policy, instructionsDigest: '0'.repeat(64) } }),
    /no longer matches/,
  );
  assert.equal(
    authorizeEditTool(f.context, 'Read', { file_path: 'greeting.js' }, () => {
      throw new Error('Journal unavailable');
    }).allowed,
    false,
  );
  assert.equal(
    authorizeEditTool(f.context, 'Write', { file_path: 'greeting.js', content: '\0' }, () => {}).allowed,
    false,
  );
  assert.equal(
    authorizeEditTool(f.context, 'Write', { file_path: 'greeting.js', content: 'a'.repeat(256 * 1024 + 1) }, () => {})
      .allowed,
    false,
  );
  linkSync(join(f.workspace.path, 'greeting.js'), join(f.root, 'alias'));
  assert.throws(() => prepareEditing(f.context), /without links/);
});

test('explicit creation supports Claude Write followed by Read/Edit and Codex add followed by update', async t => {
  const f = await fixture(t);
  f.policy.create = ['new.txt'];
  prepareEditing(f.context);
  const events: string[] = [];
  const authorize = (name: string, input: unknown) =>
    authorizeEditTool(f.context, name, input, event => events.push(event.type)).allowed;
  const add = { path: 'new.txt', kind: { type: 'add' }, diff: '+created\n' };
  assert.deepEqual(JSON.parse(editingFileContext(f.context)).at(-1), { path: 'new.txt', content: null });
  assert.equal(authorize('Read', { file_path: 'new.txt' }), false);
  assert.equal(authorize('Edit', { file_path: 'new.txt', old_string: '', new_string: 'created' }), false);
  assert.equal(authorize('Write', { file_path: 'new.txt', content: 'created\n' }), true);
  assert.equal(
    authorizeFileChanges(f.context, [add], event => events.push(event.type)),
    true,
  );
  assert.equal(
    authorizeFileChanges(f.context, [add], () => {
      throw new Error('Journal unavailable');
    }),
    false,
  );
  assert.equal(authorize('Write', { file_path: 'new.txt', content: 'created' }), true);
  assert.equal(
    authorizeEditTool(f.context, 'Write', { file_path: 'new.txt', content: 'created' }, () => {
      throw new Error('Journal unavailable');
    }).allowed,
    false,
  );
  writeFileSync(join(f.workspace.path, 'new.txt'), 'created\n');
  assert.equal(authorize('Read', { file_path: 'new.txt' }), true);
  assert.equal(authorize('Edit', { file_path: 'new.txt', old_string: 'created', new_string: 'updated' }), true);
  assert.equal(
    authorizeFileChanges(f.context, [add], () => {}),
    false,
  );
  assert.equal(
    authorizeFileChanges(f.context, [{ ...add, kind: { type: 'update' }, diff: '-created\n+updated' }], () => {}),
    true,
  );
  assert.equal(
    authorizeFileChanges(f.context, [{ ...add, kind: { type: 'delete' } }], () => {}),
    false,
  );
  verifyEditingScope(f.context, await snapshotRepository(f.workspace.path, f.workspace.baseCommit));
  assert.ok(events.includes('tool.authorized') && events.includes('tool.denied'));
});

test('creation policies reject overlaps, controls, aliases and paths without existing parents', async t => {
  const f = await fixture(t);
  for (const create of [
    ['greeting.js'],
    ['AGENTS.md'],
    ['nested/CLAUDE.md'],
    ['.codex/new.txt'],
    ['../outside'],
    ['NUL.txt'],
    ['new?.txt'],
    ['a.txt', 'a.txt'],
  ]) {
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
  symlinkSync(
    join(f.root, 'outside'),
    join(f.workspace.path, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const context = { ...f.context, policy: { ...f.policy, create: ['alias/new.txt'] } };
  assert.throws(() => prepareEditing(context), /without links/);
  assert.equal(
    authorizeEditTool(context, 'Write', { file_path: 'alias/new.txt', content: 'escape' }, () => {}).allowed,
    false,
  );
});

test('creation refuses ignored paths and previously deleted tracked paths', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path, '.gitignore'), '*.cache\n');
  rmSync(join(f.workspace.path, 'other.txt'));
  const snapshot = await f.checks.snapshot(f.execution.id);
  const policy = { ...f.policy, artifact: snapshot.artifact, create: ['new.cache'] };
  assert.throws(() => prepareEditing({ ...f.context, snapshot, policy }), /not ignored/);
  assert.throws(
    () => prepareEditing({ ...f.context, snapshot, policy: { ...policy, create: ['other.txt'] } }),
    /absent from the snapshot/,
  );
  assert.equal(
    authorizeEditTool(
      { ...f.context, snapshot, policy },
      'Write',
      { file_path: 'new.cache', content: 'ignored' },
      () => {},
    ).allowed,
    false,
  );
  assert.equal(
    authorizeFileChanges(
      { ...f.context, snapshot, policy },
      [{ path: 'new.cache', kind: { type: 'add' }, diff: '+ignored' }],
      () => {},
    ),
    false,
  );
});

test('created files must remain bounded unlinked text and visible in the final snapshot', async t => {
  const f = await fixture(t);
  f.policy.create = ['new.txt'];
  prepareEditing(f.context);
  const path = join(f.workspace.path, 'new.txt');
  for (const content of [Buffer.from([0, 255]), Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    writeFileSync(path, content);
    assert.throws(
      () =>
        verifyEditingScope(f.context, {
          ...f.snapshot,
          files: [...f.snapshot.files, { path: 'new.txt', sha256: 'fixture', executable: false }],
        }),
      /text|bounded/,
    );
  }
  writeFileSync(path, 'created');
  linkSync(path, join(f.root, 'hardlink'));
  assert.equal(
    authorizeEditTool(f.context, 'Write', { file_path: 'new.txt', content: 'rewrite' }, () => {}).allowed,
    false,
  );
  rmSync(join(f.root, 'hardlink'));
  assert.throws(() => verifyEditingScope(f.context, f.snapshot), /missing from repository snapshot/);
  writeFileSync(join(f.workspace.path, 'unauthorized.txt'), 'outside scope');
  const after = await snapshotRepository(f.workspace.path, f.workspace.baseCommit);
  assert.throws(() => verifyEditingScope(f.context, after), /outside the explicit creation policy/);
});

test('deletion policy validates distinct existing targets and current snapshot bytes', async t => {
  const f = await fixture(t);
  f.policy.delete = ['other.txt'];
  prepareEditing(f.context);
  assert.deepEqual(JSON.parse(editingFileContext(f.context)).at(-1), { path: 'other.txt', content: 'unchanged\n' });
  validateEditPolicy({ ...f.policy, files: [] });
  for (const value of [
    { ...f.policy, delete: ['greeting.js'] },
    { ...f.policy, create: ['other.txt'] },
    { ...f.policy, delete: ['AGENTS.md'] },
    { ...f.policy, delete: ['../outside'] },
    { ...f.policy, delete: ['other.txt', 'other.txt'] },
    { ...f.policy, delete: null },
  ]) {
    assert.throws(() => validateEditPolicy(value as EditPolicy));
  }
  if (process.platform === 'win32') assert.throws(() => validateEditPolicy({ ...f.policy, delete: ['GREETING.js'] }));
  assert.throws(() => validateEditPolicy({ ...f.policy, create: Array.from({ length: 63 }, (_, i) => `${i}.txt`) }));
  assert.throws(() => prepareEditing({ ...f.context, policy: { ...f.policy, delete: ['missing.txt'] } }));
  writeFileSync(join(f.workspace.path, 'other.txt'), 'changed after snapshot');
  assert.throws(() => prepareEditing(f.context), /unchanged snapshot bytes/);
});

test('scoped unlink journals permission first, forbids other writes and cannot repeat a deletion', async t => {
  const f = await fixture(t);
  f.policy.delete = ['other.txt'];
  prepareEditing(f.context);
  const path = join(f.workspace.path, 'other.txt');
  const events: string[] = [];
  assert.equal(authorizeEditTool(f.context, 'Read', { file_path: path }, () => {}).allowed, true);
  for (const [tool, input] of [
    ['Write', { file_path: path, content: '' }],
    ['Edit', { file_path: path, old_string: 'unchanged', new_string: '' }],
    [deleteFileTool, { file_path: 'greeting.js' }],
    [deleteFileTool, { file_path: path, recursive: true }],
  ] as const) {
    assert.equal(authorizeEditTool(f.context, tool, input, () => {}).allowed, false);
  }
  assert.throws(
    () =>
      deleteEditingFile(f.context, { file_path: path }, () => {
        throw new Error('Journal unavailable');
      }),
    /Journal unavailable/,
  );
  assert.equal(existsSync(path), true);
  deleteEditingFile(f.context, { file_path: path }, event => {
    if (event.type === 'tool.authorized') assert.equal(existsSync(path), true);
    if (event.type === 'tool.deleted') assert.equal(existsSync(path), false);
    events.push(event.type);
  });
  assert.deepEqual(events, ['tool.authorized', 'tool.deleted']);
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}));
  assert.equal(
    authorizeEditTool(f.context, 'Write', { file_path: path, content: 'recreated' }, () => {}).allowed,
    false,
  );
  const after = await snapshotRepository(f.workspace.path, f.workspace.baseCommit);
  verifyEditingScope(f.context, after);
  assert.ok(
    after.diff.some(file => file.path === 'other.txt' && file.after === null && file.previousContent === 'unchanged\n'),
  );
});

test('deletion refuses changed bytes, links and directories at the actual unlink boundary', async t => {
  const f = await fixture(t);
  f.policy.delete = ['other.txt'];
  const path = join(f.workspace.path, 'other.txt');
  assert.throws(
    () =>
      deleteEditingFile(f.context, { file_path: path }, event => {
        if (event.type === 'tool.authorized') writeFileSync(path, 'changed during permission journaling');
      }),
    /unchanged snapshot bytes/,
  );
  assert.equal(readFileSync(path, 'utf8'), 'changed during permission journaling');
  writeFileSync(path, 'unchanged\n');
  linkSync(path, join(f.root, 'hardlink'));
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}), /without links/);
  rmSync(join(f.root, 'hardlink'));
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => deleteEditingFile(f.context, { file_path: path }, () => {}), /regular text files/);
});

test('deletion-only scope handles empty untracked files and permits unchanged optional targets', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path, 'empty.txt'), '');
  const snapshot = await f.checks.snapshot(f.execution.id);
  const context = {
    ...f.context,
    snapshot,
    policy: { ...f.policy, artifact: snapshot.artifact, files: [], delete: ['empty.txt', 'other.txt'] },
  };
  prepareEditing(context);
  verifyEditingScope(context, snapshot);
  deleteEditingFile(context, { file_path: 'empty.txt' }, () => {});
  const after = await snapshotRepository(f.workspace.path, f.workspace.baseCommit);
  assert.ok(!after.files.some(file => file.path === 'empty.txt'));
  assert.equal(readFileSync(join(f.workspace.path, 'other.txt'), 'utf8'), 'unchanged\n');
  verifyEditingScope(context, after);
});

test('Codex delete approvals reject updates, moves, mixed unauthorized paths and stale target bytes', async t => {
  const f = await fixture(t, 'codex');
  f.policy.delete = ['other.txt'];
  const deletion = { path: 'other.txt', kind: { type: 'delete' }, diff: '-unchanged\n' };
  assert.equal(
    authorizeFileChanges(f.context, [deletion], () => {}),
    true,
  );
  for (const changes of [
    [deletion, deletion],
    [deletion, { ...deletion, path: 'greeting.js' }],
    [{ ...deletion, kind: { type: 'update' } }],
    [{ ...deletion, kind: { type: 'add' } }],
    [{ ...deletion, kind: { type: 'delete', move_path: null } }],
  ]) {
    assert.equal(
      authorizeFileChanges(f.context, changes, () => {}),
      false,
    );
  }
  assert.equal(
    authorizeFileChanges(f.context, [deletion], () => {
      throw new Error('Journal unavailable');
    }),
    false,
  );
  writeFileSync(join(f.workspace.path, 'other.txt'), 'changed');
  assert.equal(
    authorizeFileChanges(f.context, [deletion], () => {}),
    false,
  );
  const after = await snapshotRepository(f.workspace.path, f.workspace.baseCommit);
  assert.throws(() => verifyEditingScope(f.context, after), /outside the explicit/);
});

for (const provider of ['claude', 'codex'] as const)
  test(`${provider} deletion settles with retained removed bytes and no completion evidence`, windows, async t => {
    const f = await fixture(t, provider);
    f.policy.files = [];
    f.policy.delete = ['other.txt'];
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      deleteEditingFile(f.context, { file_path: 'other.txt' }, () => {});
      return fakeResult(options);
    });
    assert.equal(run.phase, 'completed', run.error ?? undefined);
    assert.ok(
      run.after?.diff.some(
        file => file.path === 'other.txt' && file.after === null && file.previousContent === 'unchanged\n',
      ),
    );
    assert.equal(f.workflow.get(f.task.id).phase, 'running');
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal(f.store.lease(f.workspace.id), null);
  });

for (const provider of ['claude', 'codex'] as const)
  test(`${provider} creation settles with a snapshot and leaves completion gates outstanding`, windows, async t => {
    const f = await fixture(t, provider);
    f.policy.files = [];
    f.policy.create = ['new.txt'];
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      writeFileSync(join(f.workspace.path, 'new.txt'), 'created\n');
      return fakeResult(options);
    });
    assert.equal(run.phase, 'completed', run.error ?? undefined);
    assert.deepEqual(run.policy.create, ['new.txt']);
    assert.ok(
      run.after?.diff.some(file => file.path === 'new.txt' && file.before === null && file.content === 'created\n'),
    );
    assert.equal(f.workflow.get(f.task.id).phase, 'running');
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal(f.store.lease(f.workspace.id), null);
  });

test('unauthorized additions and removal of writable files fail native settlement', windows, async t => {
  for (const removal of [false, true]) {
    const f = await fixture(t);
    f.policy.create = ['new.txt'];
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      writeFileSync(join(f.workspace.path, 'new.txt'), 'authorized');
      if (removal) rmSync(join(f.workspace.path, 'greeting.js'));
      else writeFileSync(join(f.workspace.path, 'outside.txt'), 'unauthorized');
      return fakeResult(options);
    });
    assert.equal(run.phase, 'failed');
    assert.match(run.error!, /outside the explicit/);
    assert.equal(readFileSync(join(f.workspace.path, 'new.txt'), 'utf8'), 'authorized');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});

test('Codex patch policy validates the whole change set and fails closed on journal errors', async t => {
  const f = await fixture(t, 'codex');
  const update = { path: 'greeting.js', kind: { type: 'update', move_path: null }, diff: '-hello\n+hello world' };
  const authorize = (changes: unknown) => authorizeFileChanges(f.context, changes, () => {});
  assert.equal(authorize([update]), true);
  for (const changes of [
    [],
    [update, { ...update, path: 'other.txt' }],
    [update, update],
    [{ ...update, path: '../outside' }],
    [{ ...update, path: 'AGENTS.md' }],
    [{ ...update, kind: { type: 'add' } }],
    [{ ...update, kind: { type: 'delete' } }],
    [{ ...update, kind: { type: 'update', move_path: 'other.txt' } }],
    [{ ...update, kind: { type: 'update', movePath: 'other.txt' } }],
    [{ ...update, diff: '\0' }],
    [{ ...update, diff: 'a'.repeat(256 * 1024 + 1) }],
  ])
    assert.equal(authorize(changes), false);
  assert.equal(
    authorizeFileChanges(f.context, [update], () => {
      throw new Error('Journal unavailable');
    }),
    false,
  );
  assert.deepEqual(JSON.parse(editingFileContext(f.context)), [
    { path: 'greeting.js', content: "console.log('hello');\n" },
  ]);
});
