// Readiness infrastructure stops can rerun the same check without spending either repair allowance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { guidedDecisionDigest } from '../src/orchestration/guided/keys.js';
import { counted, fixture, slowValidation, windows } from './helpers/guided-tasks.js';

test(
  'a timed-out readiness check retains its attempt and consumes no repair on an explicit rerun',
  windows,
  async t => {
    const f = fixture(t),
      { tasks, turns } = counted(f);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: [] },
      slices: [{ ...f.plan.slices[0], readiness: [{ ...slowValidation(join(f.root, 'once')), kind: 'types' }] }],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const stopped = await tasks.run(task.id);
    assert.equal(stopped.stopReason?.code, 'CHECK_TIMEOUT', stopped.note);
    assert.equal(stopped.stage, 'readiness');
    assert.equal(stopped.readinessCycle.used, 0);
    assert.equal(stopped.repairCycle.used, 0);
    const done = await tasks.rerunChecks(task.id, guidedDecisionDigest(stopped));
    assert.equal(done.status, 'complete', done.note);
    assert.equal(done.readinessCycle.used, 0);
    assert.equal(done.repairCycle.used, 0);
    assert.equal(turns(), 1);
    const checks = f.store.checks(stopped.executionId!).filter(check => check.purpose === 'readiness');
    assert.equal(checks.length, 2);
    assert.equal(checks[0]!.phase, 'failed');
    assert.equal(checks[1]!.phase, 'passed');
    assert.equal(checks[1]!.spec.artifact, checks[0]!.spec.artifact);
  },
);
