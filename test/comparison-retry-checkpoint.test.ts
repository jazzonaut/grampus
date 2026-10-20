// A queued earlier failure must not prevent an explicit retry of the current supervised checkpoint.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { comparisonRetries } from '../src/domain/comparison-retries.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, windows } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

test('retrying the current scope checkpoint takes priority over an earlier queued failure', windows, async t => {
  const f = fixture(t);
  const comparisons = new Comparisons(f.store);
  const source = f.tasks.create(f.plan);
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'second' }]);
  comparisons.approve(group.id, comparisonDecisionKey(group));
  const firstId = group.runs[0]!.taskId;
  const secondId = group.runs[1]!.taskId;
  f.store.transaction(() => {
    const value = f.store.comparison(group.id);
    value.cursor = 1;
    value.status = 'running';
    value.owner = { token: randomUUID(), host: 'test-host', controllerPid: process.pid, controllerStartedAt: null };
    f.store.saveComparison(value);
    f.store.appendComparison(group.id, 'comparison.started', value);
    const task = f.store.get(firstId);
    task.guided!.status = 'blocked';
    task.guided!.stopReason = {
      code: 'IMPLEMENTATION_FAILED',
      message: 'Settled fixture failure',
      at: new Date().toISOString(),
    };
    f.store.save(task.id, task);
  });
  const checkpoint = await new GuidedTasks(f.store).run(secondId);
  assert.equal(checkpoint.status, 'awaiting_scope');
  await f.tasks.retry(firstId);
  f.store.transaction(() => {
    const value = f.store.comparison(group.id);
    value.owner = null;
    value.status = 'waiting';
    f.store.saveComparison(value);
    f.store.appendComparison(group.id, 'comparison.waiting', value);
  });
  const retried = await f.tasks.retry(secondId);
  assert.equal(retried.status, 'awaiting_scope');
  assert.equal(retried.workspaceId, checkpoint.workspaceId);
  const queue = comparisonRetries(f.store, group.id);
  assert.equal(queue.active?.taskId, secondId);
  assert.deepEqual(
    queue.pending.map(item => item.taskId),
    [firstId],
  );
  assert.equal(f.store.comparison(group.id).cursor, 1);
  assert.equal(f.store.comparison(group.id).status, 'waiting');
});
