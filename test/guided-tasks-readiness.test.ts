// Readiness repairs have their own durable slice allowance; behavioural checks retain the shared one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { repairsView } from '../src/server/view-model/repairs.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

import { readiness } from './helpers/guided-readiness.js';

test('format and type fixes preserve the allowance for a behavioural repair', windows, async t => {
  const f = fixture(t),
    config = services();
  let turns = 0;
  config.implementationRunner = options => {
    const outputs = ['FORMAT TYPE', 'wrong'];
    return inlineImplementation(options, `console.log('${outputs[turns++]}');\n`);
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    quality: { passes: [] },
    workflowPolicy: { mode: 'automatic', readinessRounds: 2, repairRounds: 1, maxTaskTurns: 2 },
    slices: [{ ...f.plan.slices[0], readiness: [readiness('format', 'FORMAT'), readiness('types', 'TYPE')] }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.stopReason?.code, 'TASK_TURN_LIMIT', done.note);
  assert.equal(done.readinessCycle.used, 1);
  assert.equal(turns, 2);
  assert.equal(done.repairCycle.used, 1);
  const firstExecution = f.store
    .executions()
    .find(execution => execution.taskId === task.id && execution.role === 'implementation')!;
  assert.deepEqual(
    f.store
      .checks(firstExecution.id)
      .filter(check => check.purpose === 'readiness')
      .map(check => [check.spec.name, check.phase]),
    [
      ['format readiness', 'failed'],
      ['types readiness', 'failed'],
    ],
  );
  const decisions = f.store.events(task.id).filter(event => event.type === 'guided.repair_decided');
  assert.deepEqual(
    decisions.map(event => (event.data as { source: string }).source),
    ['readiness', 'validation'],
  );
  const executions = f.store
    .executions()
    .filter(execution => execution.taskId === task.id && execution.role === 'implementation');
  assert.equal(executions.length, 3);
  const checked = executions.findLast(execution => f.store.checks(execution.id).length > 0)!;
  const lastChecks = f.store.checks(checked.id);
  assert.ok(lastChecks.some(check => check.spec.name === 'format readiness' && check.phase === 'passed'));
  assert.ok(lastChecks.some(check => check.spec.name === 'types readiness' && check.phase === 'passed'));
  const history = repairsView(f.store.events(task.id), done);
  const readinessRepair = history.decisions.find(decision => decision.title === 'Readiness: Automatic repair')!;
  assert.deepEqual(
    readinessRepair.results.map(result => [result.name, result.outcome]),
    [
      ['format readiness', 'passed'],
      ['types readiness', 'passed'],
      ['Validation', 'failed'],
    ],
  );
});
