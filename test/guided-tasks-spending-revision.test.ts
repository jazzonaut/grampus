// Fresh approval can raise a total allowance, but it must never erase already requested turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('revision retains prior spend and a higher total permits only its additional turns', windows, async t => {
  const f = fixture(t),
    config = services();
  config.implementationRunner = options => inlineImplementation(options, "console.log('hello world');\n");
  config.connector = async () => {
    throw new Error('Both allowances end before review');
  };
  const tasks = new GuidedTasks(f.store, config);
  const plan = { ...f.plan, workflowPolicy: { mode: 'automatic', maxTaskTurns: 1 }, quality: { passes: [] } };
  const task = tasks.create(plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  const first = await tasks.run(task.id);
  assert.equal(first.stopReason?.code, 'TASK_TURN_LIMIT', first.note);
  const revised = await tasks.revise(task.id, { ...plan, workflowPolicy: { ...plan.workflowPolicy, maxTaskTurns: 2 } });
  assert.equal(taskUsage(f.store, task.id).turns, 1);
  await assert.rejects(tasks.run(task.id), /Approve/);
  tasks.approve(task.id, revised.version, revised.digest);
  const second = await tasks.run(task.id);
  assert.equal(second.stopReason?.code, 'TASK_TURN_LIMIT', second.note);
  assert.equal(second.stage, 'review');
  assert.equal(taskUsage(f.store, task.id).turns, 2);
  assert.notEqual(second.digest, first.digest);
  assert.equal(f.store.events(task.id, ['guided.spending_blocked']).length, 2);
});
