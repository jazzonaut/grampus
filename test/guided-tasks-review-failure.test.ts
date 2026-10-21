// Checks that reviewer transport failures retain their cause without authorising a replay or delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { fixture, services, windows } from './helpers/guided-tasks.js';

test('a failed reviewer connection exposes its provider error without replaying or delivering', windows, async t => {
  const f = fixture(t),
    id = f.create();
  let connections = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    connector: async () => {
      connections++;
      throw new Error('RPC message too large');
    },
  });
  await tasks.run(id);
  const assessment = await tasks.authorize(id);
  assert.equal(assessment.status, 'awaiting_assessment', assessment.note);
  const stopped = await tasks.assess(id, 'passed', 'Inspected the fixture implementation.');
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'REVIEW_TURN_FAILED');
  assert.match(stopped.note, /No independent passing review\. Inspect the findings, then use task-retry\./);
  assert.match(stopped.note, /RPC message too large/);
  assert.equal(connections, 1);
  assert.equal(stopped.owner, null);
  assert.equal(guidedTaskView(f.store, id).deliveries.length, 0);
  await assert.rejects(tasks.run(id), /blocked/);
  assert.equal(connections, 1);
  // Retrying a review that produced no verdict reviews the same verified candidate again: no new
  // implementation attempt, no rerun checks.
  const implementations = () => f.store.executions(id).filter(item => item.role === 'implementation').length;
  const checks = () => f.store.executions(id).flatMap(item => f.store.checks(item.id)).length;
  const [before, checked] = [implementations(), checks()];
  const retried = await tasks.retry(id);
  assert.equal(retried.stopReason?.code, 'REVIEW_TURN_FAILED', retried.note);
  assert.equal(connections, 2);
  assert.equal(implementations(), before);
  assert.equal(checks(), checked);
  assert.equal(f.store.executions(id).filter(item => item.role === 'review').length, 2);
});
