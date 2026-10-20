// Pins discard refusals independently of the missing-receipt scenario and provider dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { discardTask } from '../src/orchestration/task-discard.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { stopReason } from '../src/orchestration/guided/stop-reasons.js';
import { fixture } from './helpers/guided-tasks.js';

test('discard refuses ordinary tasks, live or foreign controllers and live pending-step owners', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const original = structuredClone(task);
  assert.throws(() => discardTask(f.store, task.id, guidedDecisionKey(task.guided!)), /awaiting recovery/);
  assert.deepEqual(f.store.get(task.id), original);
  task.guided!.status = 'recovery_required';
  task.guided!.stopReason = stopReason('RECOVERY_REQUIRED', 'Fixture missing receipt');
  const owner = { token: 'fixture', host: hostname(), controllerPid: process.pid, controllerStartedAt: null };
  for (const candidate of [owner, { ...owner, host: 'foreign-host' }, { ...owner, controllerStartedAt: 'unknown' }]) {
    task.guided!.owner = candidate;
    f.store.transaction(() => f.store.save(task.id, task));
    assert.throws(
      () => discardTask(f.store, task.id, guidedDecisionKey(task.guided!)),
      /alive|another host|unverifiable/,
    );
    assert.deepEqual(f.store.get(task.id), task);
  }
  task.guided!.owner = null;
  task.guided!.pending = { stage: 'preparation', known: [], assessment: null, guidance: [], controller: owner };
  f.store.transaction(() => f.store.save(task.id, task));
  assert.throws(() => discardTask(f.store, task.id, guidedDecisionKey(task.guided!)), /alive/);
  assert.deepEqual(f.store.get(task.id), task);
  assert.equal(f.store.events(task.id, ['task.discarded']).length, 0);
});
