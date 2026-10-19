// Recovery adopts durable usage and work without buying another turn or replenishing allowance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskUsage } from '../src/reporting/task-usage.js';
import { fixture, crashProgram, windows } from './helpers/guided-tasks.js';

test('adopting a completed implementation retains its spent turn and stops before review', windows, async t => {
  const f = fixture(t);
  const task = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'supervised', maxTaskTurns: 1 } });
  const id = task.id;
  f.tasks.approve(id, 1, task.guided!.digest);
  await f.tasks.run(id);
  crashProgram(f, 'authorize', 'validation', id);
  const recovered = await f.tasks.recover(id);
  assert.equal(recovered.status, 'ready', recovered.note);
  assert.equal(recovered.stage, 'validation');
  assert.equal(taskUsage(f.store, id).turns, 1);
  const checkpoint = await f.tasks.run(id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const stopped = await f.tasks.assess(id, 'passed', 'Inspected the recovered direct greeting and validation.');
  assert.equal(stopped.stopReason?.code, 'TASK_TURN_LIMIT', stopped.note);
  assert.equal(stopped.stage, 'review');
  assert.equal(stopped.pending, null);
  assert.equal(taskUsage(f.store, id).turns, 1);
  assert.equal(f.store.implementations(recovered.executionId!).length, 1);
});
