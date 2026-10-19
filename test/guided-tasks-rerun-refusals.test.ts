// Guided task tests: the conditions that refuse rerunning a stopped check: a stale decision, a changed
// artifact and an ineligible stop. Split from guided-tasks-rerun-checks to keep each file short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guidedDecisionDigest } from '../src/orchestration/guided/keys.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { windows, cli, fixture, slowValidation, counted } from './helpers/guided-tasks.js';

test(
  'rerun is refused for a stale decision, a changed artifact or an ineligible stop, and leaves the stop intact',
  windows,
  async t => {
    const f = fixture(t);
    const { tasks, turns } = counted(f);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      slices: [{ ...f.plan.slices[0]!, validation: slowValidation(null) }],
    });
    const draft = guidedDecisionDigest(task.guided!);
    tasks.approve(task.id, 1, task.guided!.digest);
    const stopped = await tasks.run(task.id);
    assert.equal(stopped.stopReason?.code, 'CHECK_TIMEOUT', stopped.note);
    const key = guidedDecisionDigest(stopped);
    await assert.rejects(tasks.rerunChecks(task.id, draft), /Task changed since you inspected it/);
    await assert.rejects(tasks.rerunChecks(task.id, 'not-a-key'), /Task changed since you inspected it/);

    const workspace = f.store.workspaces().find(item => item.taskId === task.id)?.path;
    assert.ok(workspace, 'The task has a workspace');
    writeFileSync(join(workspace, 'greeting.js'), "console.log('edited by hand');\n");
    await assert.rejects(tasks.rerunChecks(task.id, key), /workspace changed since the check ran/);
    const unchanged = tasks.get(task.id);
    assert.equal(unchanged.status, 'blocked');
    assert.equal(unchanged.stopReason?.code, 'CHECK_TIMEOUT');
    assert.equal(f.store.checks(stopped.executionId!).length, 1);
    writeFileSync(join(workspace, 'greeting.js'), "console.log('hello world');\n");

    // The CLI command reruns it; the check times out again and the task stops for the same reason.
    assert.throws(
      () =>
        execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-rerun-checks', task.id, key], {
          windowsHide: true,
          stdio: 'pipe',
        }),
      (error: { status: number }) => error.status === 1,
    );
    const again = tasks.get(task.id);
    assert.equal(again.stopReason?.code, 'CHECK_TIMEOUT');
    assert.equal(f.store.checks(stopped.executionId!).length, 2);
    assert.notEqual(again.failedCheckId, stopped.failedCheckId);
    await assert.rejects(tasks.rerunChecks(task.id, key), /Task changed since you inspected it/);
    assert.equal(turns(), 1);

    const failing = tasks.create({
      ...f.plan,
      workspace: { ...f.plan.workspace, path: join(f.root, 'failing') },
      workflowPolicy: { mode: 'automatic', repairRounds: 0 },
      slices: [{ ...f.plan.slices[0]!, validation: { file: 'node', args: ['-e', 'process.exit(1)'] } }],
    });
    tasks.approve(failing.id, 1, failing.guided!.digest);
    const exhausted = await tasks.run(failing.id);
    assert.equal(exhausted.stopReason?.code, 'CHECK_REPAIR_EXHAUSTED', exhausted.note);
    assert.equal(guidedTaskView(f.store, failing.id).rerun, null);
    await assert.rejects(
      tasks.rerunChecks(failing.id, guidedDecisionDigest(exhausted)),
      /Rerun checks applies after CHECK_TIMEOUT/,
    );
  },
);
