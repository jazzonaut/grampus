// A settled readiness check is adopted after a controller crash, never dispatched a second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checks } from '../src/verification/checks.js';
import { fixture, crashProgram, windows } from './helpers/guided-tasks.js';
import { readiness } from './helpers/guided-readiness.js';

test(
  'recovery adopts a settled readiness result without replaying the check or spending a repair',
  windows,
  async t => {
    const f = fixture(t);
    const task = f.tasks.create({
      ...f.plan,
      slices: [{ ...f.plan.slices[0], readiness: [readiness('types', 'FORMAT')] }],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    await f.tasks.run(task.id);
    crashProgram(f, 'authorize', 'validation', task.id);
    const pending = f.tasks.get(task.id);
    assert.equal(pending.pending?.stage, 'readiness');
    const before = f.store.checks(pending.executionId!).filter(check => check.purpose === 'readiness');
    assert.equal(before.length, 1);
    assert.equal(before[0]!.phase, 'passed');
    const recovered = await f.tasks.recover(task.id);
    assert.equal(recovered.status, 'ready', recovered.note);
    assert.equal(recovered.stage, 'validation');
    assert.equal(recovered.pending, null);
    assert.equal(recovered.readinessCycle.used, 0);
    assert.equal(recovered.repairCycle.used, 0);
    assert.equal(f.store.checks(pending.executionId!).filter(check => check.purpose === 'readiness').length, 1);
    const checks = new Checks(f.store);
    await assert.rejects(checks.finish(pending.executionId!, before[0]!.id), /Readiness cannot substitute/);
    writeFileSync(join(f.plan.workspace.path, 'greeting.js'), "console.log('changed after readiness');\n");
    const snapshot = await checks.snapshot(pending.executionId!);
    const ordinary = await checks.run(pending.executionId!, {
      name: 'Ordinary validation',
      file: process.execPath,
      args: ['-e', ''],
      timeoutMs: 1000,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
    });
    assert.equal(ordinary.phase, 'passed');
    await assert.rejects(
      checks.finish(pending.executionId!, ordinary.id),
      /Every approved readiness check must pass on this artifact/,
    );
    assert.equal(
      f.store.get(task.id).evidence.some(evidence => evidence.kind === 'validation'),
      false,
    );
  },
);
