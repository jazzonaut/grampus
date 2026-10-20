// Real receipts settle a lost group without replay and without accepting recovered success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheckProcess } from '../src/process/check-process.js';
import { fixture, deadController, windows } from './helpers/checks.js';

test('group recovery requires every outstanding receipt and never promotes recovered success', windows, async t => {
  const f = await fixture(t),
    base = await f.spec();
  let calls = 0;
  const checks = await f.checks.readinessGroup(
    f.execution.id,
    [
      { ...base, name: 'Lint', readiness: 'lint' },
      { ...base, name: 'Types', readiness: 'types' },
    ],
    undefined,
    async options => {
      calls++;
      const lost = f.store.check(options.receipt!.checkId).spec.readiness === 'types';
      const result = await runCheckProcess(options);
      return lost ? { ...result, reason: 'supervisor_lost', exitConfirmed: false } : result;
    },
  );
  assert.equal(checks[1]!.phase, 'recovery_required');
  deadController(f);
  f.checks.recover(checks[0]!.id);
  assert.equal(calls, 2);
  assert.equal(f.store.check(checks[1]!.id).phase, 'interrupted');
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.equal(f.store.get(f.task.id).attempt?.outcome, 'running');
});
