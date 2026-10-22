import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { foldEvents } from '../src/pipeline/state.js';
import { listTaskIds, TaskStore } from '../src/store/task-store.js';

function newStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-store-'));
  const store = TaskStore.create(dataDir, 'task-1');
  store.append({
    type: 'task.created',
    taskId: 'task-1',
    title: 'T',
    request: 'R',
    repoPath: '/repo',
    recipe: standardRecipe,
  });
  return { dataDir, store };
}

test('a torn final line is ignored and the rest of the log folds', () => {
  const { dataDir, store } = newStore();
  appendFileSync(store.eventsPath, '{"type":"run.created","runId":"r');
  const reopened = TaskStore.open(dataDir, 'task-1');
  assert.equal(reopened.events().length, 2);
  assert.equal(foldEvents(reopened.events()).runId, null);
  assert.deepEqual(listTaskIds(dataDir), ['task-1']);
});

test('an append after a torn final line keeps the log readable', () => {
  const { dataDir, store } = newStore();
  appendFileSync(store.eventsPath, '{"type":"run.created","runId":"r');
  const resumed = TaskStore.open(dataDir, 'task-1');
  resumed.append({ type: 'run.created', runId: 'run_2', coordinatorHandle: null });
  const events = TaskStore.open(dataDir, 'task-1').events();
  assert.equal(events.length, 3, 'the torn event stays unrecorded; the next one is recorded');
  assert.equal(foldEvents(events).runId, 'run_2');
});

test('a command queued after a torn command line is read back', () => {
  const { store } = newStore();
  appendFileSync(store.commandsPath, '{"id":"');
  const command = {
    id: randomUUID(),
    at: new Date().toISOString(),
    source: 'cli' as const,
    kind: 'accept' as const,
  };
  store.addCommand(command);
  assert.deepEqual(store.commands(), [command]);
});

test('a log written with another schema is refused', () => {
  const { dataDir, store } = newStore();
  writeFileSync(store.eventsPath, '{"type":"log.header","schema":0,"at":"x"}\n');
  assert.throws(() => TaskStore.open(dataDir, 'task-1'), /another Grampus version/);
});

test('commands are validated when queued and read back', () => {
  const { store } = newStore();
  const command = {
    id: randomUUID(),
    at: new Date().toISOString(),
    source: 'chat' as const,
    kind: 'approve' as const,
    specVersion: 1,
  };
  store.addCommand(command);
  assert.deepEqual(store.commands(), [command]);
  assert.throws(() => store.addCommand({ ...command, kind: 'approve', specVersion: 0 }));
  assert.throws(() => TaskStore.create(join(store.dir, '..', '..'), 'task-1'), /already exists/);
  assert.throws(() => TaskStore.open(store.dir, '../escape'), /Invalid task id/);
});
