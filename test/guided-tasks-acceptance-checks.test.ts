// Guided task tests: a slice with several acceptance checks runs them in order on one artifact, stops
// at the first failure naming that check, resumes a rerun at the stopped check and reruns every
// check after a repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guidedDecisionDigest } from '../src/orchestration/guided/keys.js';
import type { Store } from '../src/persistence/store.js';
import { Workflow } from '../src/domain/workflow.js';
import { windows, fixture, counted } from './helpers/guided-tasks.js';

/** An acceptance check that appends one line to `log` (outside the workspace) on every run. */
function counting(name: string, log: string) {
  return {
    name,
    file: 'node',
    args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(log)},'run\\n');console.log('first ok')`],
    expectedStdout: 'first ok\n',
    timeoutMs: 15000,
  };
}

/** The greeting acceptance check, which on its first run either hangs past its limit or prints the wrong output. */
function flaky(name: string, marker: string, first: 'hang' | 'mismatch') {
  const once =
    first === 'hang' ? "console.log('before the hang');setTimeout(() => {}, 60000)" : "console.log('not yet')";
  return {
    name,
    file: 'node',
    args: [
      '-e',
      `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'');${once}}else{process.stdout.write(require('node:child_process').execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}))}`,
    ],
    expectedStdout: 'hello world\n',
    timeoutMs: first === 'hang' ? 1000 : 15000,
  };
}

const runs = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

/** Every acceptance check of `executionId` in run order, as its name, phase and checked artifact. */
function acceptance(store: Store, executionId: string) {
  return store
    .checks(executionId)
    .filter(check => check.purpose === 'verification')
    .map(check => ({ name: check.spec.name, phase: check.phase, artifact: check.spec.artifact }));
}

test('acceptance checks run in order on one artifact and each must pass before delivery', windows, async t => {
  const f = fixture(t);
  const { tasks } = counted(f);
  const log = join(f.root, 'unit-runs');
  const greeting = { ...f.plan.slices[0]!.acceptance[0]!, name: 'Greeting' };
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [{ ...f.plan.slices[0]!, acceptance: [counting('Unit', log), greeting] }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  const checks = acceptance(f.store, done.executionId!);
  assert.deepEqual(
    checks.map(item => [item.name, item.phase]),
    [
      ['Unit', 'passed'],
      ['Greeting', 'passed'],
    ],
  );
  assert.equal(new Set(checks.map(item => item.artifact)).size, 1);
  const verification = f.store.get(task.id).evidence.filter(item => item.kind === 'verification');
  assert.deepEqual(
    verification.filter(item => item.outcome === 'passed').map(item => item.check),
    ['Unit', 'Greeting'],
    'each passed verification names the acceptance check it came from',
  );
});

test('a timed-out later acceptance check names itself and a rerun resumes at that check', windows, async t => {
  const f = fixture(t);
  const { tasks, turns } = counted(f);
  const log = join(f.root, 'unit-runs');
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      { ...f.plan.slices[0]!, acceptance: [counting('Unit', log), flaky('Browser', join(f.root, 'm'), 'hang')] },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stage, 'verification');
  assert.equal(stopped.stopReason?.code, 'CHECK_TIMEOUT');
  assert.match(stopped.stopReason?.message ?? '', /^Acceptance 'Browser' \(2 of 2\) exceeded its 1 s limit/);
  assert.equal(runs(log), 1);
  const blockers = new Workflow(f.store).sliceBlockers(task.id);
  assert.ok(blockers.includes("verification 'Browser' has not passed"), blockers.join('; '));
  assert.ok(!blockers.some(reason => reason.includes("'Unit'")), 'the passed check is not a blocker');

  const done = await tasks.rerunChecks(task.id, guidedDecisionDigest(stopped));
  assert.equal(done.status, 'complete', done.note);
  assert.equal(turns(), 1, 'no new implementation turn');
  assert.equal(runs(log), 1, 'the passed earlier check on the same artifact is not rerun');
  const checks = acceptance(f.store, stopped.executionId!);
  assert.deepEqual(
    checks.map(item => [item.name, item.phase]),
    [
      ['Unit', 'passed'],
      ['Browser', 'failed'],
      ['Browser', 'passed'],
    ],
  );
  assert.equal(new Set(checks.map(item => item.artifact)).size, 1);
});

test('a failed later acceptance check is repaired and every acceptance check runs again', windows, async t => {
  const f = fixture(t);
  const { tasks, turns } = counted(f);
  const log = join(f.root, 'unit-runs');
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      { ...f.plan.slices[0]!, acceptance: [counting('Unit', log), flaky('Greeting', join(f.root, 'm'), 'mismatch')] },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(done.repairCycle.used, 1);
  assert.equal(turns(), 2, 'one repair turn');
  assert.equal(runs(log), 2, 'a repair invalidates every earlier acceptance result');
  const decision = f.store.events(task.id).find(event => event.type === 'guided.repair_decided');
  assert.match(String((decision?.data as { trigger?: string }).trigger), /^Greeting \(2 of 2\): /);
});
