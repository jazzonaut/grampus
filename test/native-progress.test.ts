// Exercises the dashboard's current-turn summary against real session journals, without providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { agentProgress } from '../src/orchestration/planner-progress.js';
import { taskWorkView } from '../src/server/view-model/task-work.js';

test('native tool activity survives output deltas and unrelated tool completions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'grampus-activity-'));
  const store = new Store(join(directory, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const sessions = new Sessions(store);
  const session = sessions.create('codex', directory);
  const claim = sessions.claim(session.id, 'PRIVATE PROMPT');
  const emit = (type: string, data: unknown) => sessions.event(session.id, claim.runId, { type, data });
  const progress = () => agentProgress(store.sessionEvents(session.id), sessions.get(session.id), 'implementation')!;
  emit('activity.started', { id: 'command', kind: 'tool', name: 'commandExecution' });
  assert.equal(progress().activity, 'Running a command');
  emit('output.delta', { text: 'PRIVATE PARTIAL RESPONSE' });
  assert.equal(progress().activity, 'Running a command');
  emit('tool.authorized', { tool: 'Read', path: 'context.ts' });
  assert.equal(progress().activity, 'Running a command');
  emit('activity.started', { id: 'edit', kind: 'tool', name: 'fileChange' });
  assert.equal(progress().activity, 'Changing files');
  emit('activity.completed', { id: 'edit', kind: 'tool', name: 'fileChange', status: 'completed' });
  assert.equal(progress().activity, 'Running a command');
  emit('activity.completed', { id: 'command', kind: 'tool', name: 'commandExecution', status: 'failed' });
  assert.ok(progress().recent.some(item => item.label === 'Command failed'));
  assert.doesNotMatch(progress().activity, /Running a command/);
  assert.doesNotMatch(JSON.stringify(progress()), /PRIVATE/);
  sessions.settle(session.id, claim.runId, { status: 'interrupted', reply: null, usage: null, error: null }, true);
  sessions.claim(session.id, 'Next turn');
  assert.deepEqual(progress().recent, []);
});

test('the compact work feed keeps the latest turn, correlates unnamed results and redacts settled updates', t => {
  const directory = mkdtempSync(join(tmpdir(), 'grampus-work-feed-'));
  const store = new Store(join(directory, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const sessions = new Sessions(store);
  const session = sessions.create('claude', directory);
  const first = sessions.claim(session.id, 'PRIVATE PROMPT');
  sessions.event(session.id, first.runId, {
    type: 'activity.started',
    data: { id: 'old', kind: 'tool', name: 'Read' },
  });
  sessions.settle(
    session.id,
    first.runId,
    {
      status: 'completed',
      reply: {
        kind: 'message',
        text: 'Adjusted rendering; password=hidden. Checking next.',
        questions: [],
        findings: [],
      },
      usage: null,
      error: null,
    },
    true,
  );
  const next = sessions.claim(session.id, 'Continue');
  const emit = (type: string, data: unknown) => sessions.event(session.id, next.runId, { type, data });
  emit('activity.requested', { id: 'tool', kind: 'tool', name: 'Bash' });
  const progress = () => agentProgress(store.sessionEvents(session.id), sessions.get(session.id), 'implementation')!;
  assert.doesNotMatch(progress().activity, /Running a command/);
  emit('activity.progress', { id: 'tool', kind: 'tool', name: 'Bash' });
  assert.equal(progress().activity, 'Running a command');
  emit('output.delta', { text: 'PRIVATE PARTIAL OUTPUT' });
  emit('activity.completed', { id: 'tool', kind: 'tool', status: 'completed' });
  emit('activity.completed', { id: 'unknown', kind: 'tool', name: 'Edit' });
  const revision = store.revision();
  const work = taskWorkView(store, sessions.get(session.id));
  assert.equal(store.revision(), revision);
  assert.deepEqual(
    work.recent.map(item => item.label),
    ['File edit result unknown', 'Command completed'],
  );
  assert.ok(work.update?.text.includes('Adjusted rendering'));
  assert.doesNotMatch(JSON.stringify(work), /hidden|PRIVATE|File read/);
  assert.equal(taskWorkView(store, null).update, null);
});
