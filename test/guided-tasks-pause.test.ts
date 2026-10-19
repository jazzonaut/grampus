// Exercises pausing at a settled boundary without interrupting or replaying provider work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { fixture, services, windows, inlineImplementation } from './helpers/guided-tasks.js';

test('pause finishes implementation, retains evidence and resumes without another implementation', windows, async t => {
  const f = fixture(t);
  const config = services();
  let turns = 0;
  config.implementationRunner = async options => {
    turns++;
    const before = tasks.get(id);
    new GuidedTasks(f.store, { expectedState: guidedDecisionKey(before) }).pause(id);
    const result = await inlineImplementation(options, "console.log('hello world');\n");
    assert.equal(options.signal?.aborted, false, 'pause must not abort the provider');
    return result;
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create(f.plan);
  const id = task.id;
  tasks.approve(id, 1, task.guided!.digest);
  assert.equal((await tasks.run(id)).status, 'awaiting_scope');
  const paused = await tasks.authorize(id);
  assert.equal(paused.status, 'blocked', paused.note);
  assert.equal(paused.stopReason?.code, 'USER_PAUSED');
  assert.equal(paused.pending, null);
  assert.equal(paused.owner, null);
  assert.match(guidedTaskView(f.store, id).next, /task-run/);
  assert.ok(paused.snapshot?.changedPaths.includes('greeting.js'));
  assert.equal(f.store.implementations(paused.executionId!).length, 1);
  assert.equal(f.store.checks(paused.executionId!).length, 0, 'no next operation starts');
  const resumed = await new GuidedTasks(f.store, config).run(id);
  assert.equal(resumed.status, 'awaiting_assessment', resumed.note);
  assert.equal(turns, 1);
});

test('pause rejects idle and stale requests without changing the task', t => {
  const f = fixture(t);
  const id = f.create();
  assert.throws(() => f.tasks.pause(id), /No guided controller/);
  assert.throws(() => new GuidedTasks(f.store, { expectedState: 'stale' }).pause(id), /changed since/);
  assert.equal(f.tasks.get(id).pauseRequested, false);
});
