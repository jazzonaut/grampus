// Guided task tests: rerunning a check stopped by an infrastructure problem on the unchanged artifact,
// without an agent turn or a new implementation attempt. Refusals are in
// guided-tasks-rerun-refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { guidedDecisionDigest } from '../src/orchestration/guided/keys.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { readCheckLog } from '../src/verification/check-output.js';
import { windows, fixture, slowValidation, slowValidationOutput, counted } from './helpers/guided-tasks.js';

test(
  'rerun after a timeout runs a new check on the same artifact without a new attempt or agent turn',
  windows,
  async t => {
    const f = fixture(t);
    const { tasks, turns } = counted(f);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      slices: [{ ...f.plan.slices[0]!, validation: slowValidation(join(f.root, 'validation-ran-once')) }],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const stopped = await tasks.run(task.id);
    assert.equal(stopped.status, 'blocked', stopped.note);
    assert.equal(stopped.stopReason?.code, 'CHECK_TIMEOUT');
    assert.match(
      stopped.stopReason?.message ?? '',
      /^Validation 'Validation' exceeded its 1 s limit after \d+(\.\d)? s; partial output retained \(\d+ bytes\)\./,
    );
    const timedOut = f.store.checks(stopped.executionId!).find(check => check.purpose === 'validation')!;
    assert.ok((timedOut.result?.elapsedMs ?? 0) >= 1000, 'the supervisor measured the run up to its limit');
    assert.match(
      readCheckLog(timedOut, 'stdout').content,
      new RegExp(slowValidationOutput),
      'output printed before the kill is kept in the durable log',
    );
    assert.equal(stopped.repairCycle.used, 0, 'a timeout never spends the repair allowance');
    assert.equal(turns(), 1);
    const attempt = f.store.get(task.id).attempt!.id;
    const view = guidedTaskView(f.store, task.id);
    assert.match(view.next, /task-rerun-checks/);
    assert.equal(view.rerun, view.next);

    const done = await tasks.rerunChecks(task.id, guidedDecisionDigest(stopped));
    assert.equal(done.status, 'complete', done.note);
    assert.equal(turns(), 1, 'no new implementation turn');
    const execution = f.store.execution(stopped.executionId!);
    const checks = f.store.checks(execution.id).filter(check => check.purpose === 'validation');
    assert.equal(checks.length, 2);
    assert.equal(checks[0]!.result?.reason, 'timed_out');
    assert.equal(checks[1]!.phase, 'passed');
    assert.equal(checks[1]!.spec.artifact, checks[0]!.spec.artifact);
    assert.equal(execution.attemptId, attempt);
    assert.equal(
      f.store.executions().filter(item => item.taskId === task.id && item.role === 'implementation').length,
      1,
    );
    assert.equal(f.store.sessionEvents(execution.sessionId).filter(event => event.type === 'turn.requested').length, 1);
    assert.ok(f.store.events(task.id).some(event => event.type === 'guided.checks_rerun_requested'));
  },
);
