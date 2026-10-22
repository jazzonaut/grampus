// `grampus remove`: deleting a finished task's folder, and its worktree when asked, without ever
// racing a live driver or leaving a half-removed task behind.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTask } from '../src/pipeline/create-task.js';
import { removeTask } from '../src/pipeline/remove-task.js';
import { foldEvents } from '../src/pipeline/state.js';
import { acquireDriverLock } from '../src/store/driver-lock.js';
import { listTaskIds, TaskStore } from '../src/store/task-store.js';
import { FakeOrca } from './helpers/fake-orca.js';
import { createRepository, useTestSettings } from './helpers/task-fixture.js';

/** A task created like `grampus new`, finished unless `finished` is false. */
async function task(options: { finished?: boolean; comparison?: boolean } = {}) {
  useTestSettings();
  const orca = new FakeOrca(() => 'hang');
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-remove-'));
  const created = await createTask(
    {
      dataDir,
      repoPath: await createRepository(),
      request: 'Greet by name',
      title: 'Greet',
      driveCommand: id => `drive ${id}`,
      ...(options.comparison ? { comparison: { comparisonId: 'cmp-1', baseSha: null, spec: null } } : {}),
    },
    orca,
  );
  const store = TaskStore.open(dataDir, created.taskId);
  // Workers leave files under .grampus/, which Git ignores; they must not block the removal.
  mkdirSync(join(created.worktree, '.grampus'), { recursive: true });
  writeFileSync(join(created.worktree, '.grampus', 'spec.md'), '# Spec\n');
  if (options.finished !== false)
    store.append({ type: 'task.finished', outcome: 'abandoned', sha: null, override: false, reason: null });
  return { orca, dataDir, taskId: created.taskId, worktree: created.worktree, store };
}

test('removing a finished task deletes its folder and keeps its worktree unless asked', async () => {
  const { orca, dataDir, taskId, worktree, store } = await task();
  const removed = await removeTask(dataDir, taskId, { worktree: false, force: false }, orca);
  assert.equal(removed.worktree, 'kept');
  assert.equal(existsSync(store.dir), false);
  assert.deepEqual(listTaskIds(dataDir), []);
  assert.ok(existsSync(worktree), 'the worktree stays');
  assert.deepEqual(orca.removedWorktrees, []);
});

test('removing a task with its worktree closes the driver tab and removes the worktree through Orca', async () => {
  const { orca, dataDir, taskId, worktree, store } = await task();
  const removed = await removeTask(dataDir, taskId, { worktree: true, force: false }, orca);
  assert.equal(removed.worktree, 'removed');
  assert.ok(orca.closed.includes('term_driver'), 'no shell holds the worktree open');
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(store.dir), false);
});

test('an unfinished task is removed only with force, and never while its driver runs', async () => {
  const { orca, dataDir, taskId, store } = await task({ finished: false });
  await assert.rejects(removeTask(dataDir, taskId, { worktree: false, force: false }, orca), /has not finished/);
  assert.ok(existsSync(store.eventsPath));

  const lock = acquireDriverLock(store.dir);
  try {
    await assert.rejects(removeTask(dataDir, taskId, { worktree: true, force: true }, orca), /driver is running/);
  } finally {
    lock.release();
  }
  assert.ok(existsSync(store.eventsPath), 'nothing was removed');
  assert.deepEqual(orca.removedWorktrees, []);

  await removeTask(dataDir, taskId, { worktree: false, force: true }, orca);
  assert.equal(existsSync(store.dir), false);
});

test('a comparison entry is refused', async () => {
  const { orca, dataDir, taskId, store } = await task({ comparison: true });
  await assert.rejects(removeTask(dataDir, taskId, { worktree: true, force: true }, orca), /entry of comparison/);
  assert.ok(existsSync(store.eventsPath));
});

test('a worktree with uncommitted changes keeps the task unless forced', async () => {
  const { orca, dataDir, taskId, worktree, store } = await task();
  writeFileSync(join(worktree, 'half-done.js'), '// a worker stopped here\n');
  await assert.rejects(removeTask(dataDir, taskId, { worktree: true, force: false }, orca), /--force/);
  assert.ok(existsSync(store.eventsPath), 'the task stays so the removal can be repeated');
  assert.ok(existsSync(worktree));

  await removeTask(dataDir, taskId, { worktree: true, force: true }, orca);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(store.dir), false);
});

test('an uncertain worktree removal keeps the task; a repeat finds the worktree gone and finishes', async () => {
  const { orca, dataDir, taskId, store } = await task();
  orca.uncertainRemovals = 1;
  await assert.rejects(removeTask(dataDir, taskId, { worktree: true, force: false }, orca), /run it again/);
  assert.ok(existsSync(store.eventsPath));

  // The worktree went anyway, as an uncertain call may have done.
  await orca.removeWorktree(foldEvents(store.events()).workspace?.worktreeId ?? '', { force: false });
  const removed = await removeTask(dataDir, taskId, { worktree: true, force: false }, orca);
  assert.equal(removed.worktree, 'already-gone');
  assert.equal(existsSync(store.dir), false);
});
