// A task-wide turn allowance must stop before review and survive reopening and explicit retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { Store } from '../src/persistence/store.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'the last allowed implementation settles, then review stops without consuming queued guidance',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let implementations = 0,
      reviews = 0;
    config.implementationRunner = options => {
      implementations++;
      return inlineImplementation(options, "console.log('hello world');\n");
    };
    config.connector = async () => {
      reviews++;
      throw new Error('Review must not dispatch');
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic', maxTaskTurns: 1 },
      quality: { passes: [] },
    });
    const id = task.id;
    tasks.approve(id, 1, task.guided!.digest);
    const message = tasks.queueGuidance(id, 'Inspect the output.', 'reviewer').guidance[0]!;
    const stopped = await tasks.run(id);
    assert.equal(stopped.stopReason?.code, 'TASK_TURN_LIMIT', stopped.note);
    assert.equal(stopped.stage, 'review');
    assert.equal(stopped.pending, null);
    assert.equal(stopped.owner, null);
    assert.equal(stopped.guidance[0]!.id, message.id);
    assert.equal(taskUsage(f.store, id).turns, 1);
    assert.equal(f.store.deliveries(stopped.executionId!).length, 0);
    await assert.rejects(tasks.retry(id), /revise|approval/i);
    const reopened = new Store(f.store.path);
    try {
      const resumed = new GuidedTasks(reopened, config);
      assert.equal(resumed.get(id).stopReason?.code, 'TASK_TURN_LIMIT');
      await assert.rejects(resumed.run(id), /blocked/i);
    } finally {
      reopened.close();
    }
    assert.equal(implementations, 1);
    assert.equal(reviews, 0);
  },
);
