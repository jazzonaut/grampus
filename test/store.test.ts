// Store tests: the single journal schema, the default journal name and refusal of other versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, defaultDatabasePath } from '../src/persistence/store.js';
import { BoundaryError } from '../src/process/boundary.js';
import { guidedRecord, taskRecord } from './helpers/task-records.js';

function directory(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'grampus-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a new journal gets the current schema at version 8 and reopens with its records', t => {
  const path = join(directory(t), 'nested', 'grampus.sqlite');
  const store = new Store(path);
  const kept = taskRecord('task');
  store.transaction(() => {
    store.save('task', kept);
    store.append('task', 1, 'task.created', {});
  });
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 8);
  } finally {
    db.close();
  }
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.get('task'), kept);
    assert.equal(reopened.events('task').length, 1);
  } finally {
    reopened.close();
  }
});

test('an empty existing file is initialised as a new journal', t => {
  const path = join(directory(t), 'empty.sqlite');
  writeFileSync(path, '');
  const store = new Store(path);
  try {
    assert.deepEqual(store.list(), []);
  } finally {
    store.close();
  }
});

test('a journal from an older version is refused and left byte-for-byte unchanged', t => {
  const root = directory(t),
    path = join(root, 'journal.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA journal_mode = DELETE;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO tasks VALUES ('old', '{"title":"preserved"}');
    PRAGMA user_version = 10;`);
  old.close();
  const before = readFileSync(path);
  assert.throws(
    () => new Store(path),
    (error: Error) =>
      error.message ===
      `This journal was created by an older Grampus version and cannot be opened. Start with a fresh journal (the old file is left untouched): ${path}`,
  );
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(`${path}-wal`), false);
});

test('a current-version journal without the expected tables is refused', t => {
  const path = join(directory(t), 'partial.sqlite');
  const partial = new DatabaseSync(path);
  partial.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL); PRAGMA user_version = 8;');
  partial.close();
  const before = readFileSync(path);
  assert.throws(() => new Store(path), /created by an older Grampus version/);
  assert.deepEqual(readFileSync(path), before);
});

test('the default journal is grampus.sqlite in the data directory', t => {
  const root = directory(t),
    original = process.env.GRAMPUS_HOME;
  t.after(() => {
    if (original === undefined) delete process.env.GRAMPUS_HOME;
    else process.env.GRAMPUS_HOME = original;
  });
  process.env.GRAMPUS_HOME = root;
  assert.equal(defaultDatabasePath(), join(root, 'grampus.sqlite'));
});

test('task records are validated with their guided state on every read and keep their stored bytes', t => {
  const path = join(directory(t), 'grampus.sqlite');
  // Closed in the test body: `directory` removes the folder in an earlier-registered after hook.
  const store = new Store(path);
  const task = taskRecord('guided', { guided: guidedRecord() });
  store.save(task.id, task);
  const stored = new DatabaseSync(path);
  try {
    const raw = (id: string) => stored.prepare('SELECT state FROM tasks WHERE id = ?').get(id)?.['state'];
    // Validation is in place: the record read back serialises to exactly the stored text.
    assert.equal(JSON.stringify(store.get(task.id)), raw(task.id));
    stored
      .prepare('UPDATE tasks SET state = ? WHERE id = ?')
      .run(JSON.stringify({ ...task, guided: { ...task.guided, status: 'unknown_status' } }), task.id);
    assert.throws(
      () => store.get(task.id),
      (error: unknown) =>
        error instanceof BoundaryError &&
        error.kind === 'journal-record' &&
        error.source === 'tasks' &&
        error.issues.some(issue => issue.startsWith('guided.status')),
    );
    assert.throws(() => store.list(), BoundaryError);
  } finally {
    stored.close();
    store.close();
  }
});
