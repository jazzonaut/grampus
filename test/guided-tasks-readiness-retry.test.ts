// Readiness spending survives persisted state and explicit retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { Store } from '../src/persistence/store.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';
import { readiness } from './helpers/guided-readiness.js';

test('exhausted readiness spending survives reopening and an explicit retry', windows, async t => {
  const f = fixture(t),
    config = services();
  let turns = 0;
  config.implementationRunner = options => inlineImplementation(options, `console.log('FORMAT ${++turns}');\n`);
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic', readinessRounds: 1, repairRounds: 3 },
    slices: [{ ...f.plan.slices[0], readiness: [readiness('format', 'FORMAT')] }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.stopReason?.code, 'READINESS_REPAIR_EXHAUSTED', stopped.note);
  assert.equal(stopped.repairCycle.used, 0);
  assert.equal(turns, 2);
  const reopened = new Store(f.store.path);
  try {
    const resumed = new GuidedTasks(reopened, config);
    const again = await resumed.retry(task.id);
    assert.equal(again.stopReason?.code, 'READINESS_REPAIR_EXHAUSTED', again.note);
    assert.equal(again.repairCycle.used, 0);
    assert.equal(turns, 3);
    assert.equal(
      reopened.events(task.id).filter(event => event.type === 'guided.readiness_repair_requested').length,
      1,
    );
  } finally {
    reopened.close();
  }
});
