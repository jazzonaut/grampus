// Parallel readiness owns one lease until every child settles; uncertain exits cannot be bypassed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, windows, deadController } from './helpers/checks.js';

test('readiness children dispatch concurrently and settle without releasing each others lease', windows, async t => {
  const f = await fixture(t);
  const base = await f.spec();
  let started = 0;
  let release!: () => void;
  const together = new Promise<void>(resolve => {
    release = resolve;
  });
  const result = await f.checks.readinessGroup(
    f.execution.id,
    [
      { ...base, name: 'Lint', readiness: 'lint' },
      { ...base, name: 'Types', readiness: 'types' },
    ],
    undefined,
    async () => {
      started++;
      if (started === 2) release();
      await together;
      assert.ok(f.store.lease(f.workspace.id));
      return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
    },
  );
  assert.equal(started, 2);
  assert.ok(result.every(check => check.phase === 'passed'));
  assert.equal(result[0]!.groupId, result[1]!.groupId);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('an uncertain group retains its lease and missing receipts prevent recovery without replay', windows, async t => {
  const f = await fixture(t),
    base = await f.spec();
  let calls = 0;
  const result = await f.checks.readinessGroup(
    f.execution.id,
    [
      { ...base, name: 'Lint', readiness: 'lint' },
      { ...base, name: 'Types', readiness: 'types' },
    ],
    undefined,
    async () => ({
      reason: ++calls === 1 ? 'supervisor_lost' : 'exited',
      exitCode: 0,
      exitConfirmed: calls !== 1,
      stdout: '',
      stderr: '',
      outputTruncated: false,
    }),
  );
  assert.equal(calls, 2);
  assert.ok(result.some(check => check.phase === 'recovery_required'));
  assert.equal(f.store.lease(f.workspace.id)?.runId, result[0]!.groupId);
  deadController(f);
  assert.throws(() => f.checks.recover(result[0]!.id));
  assert.ok(f.store.lease(f.workspace.id));
  assert.equal(calls, 2);
});
