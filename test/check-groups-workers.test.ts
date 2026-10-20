// A configurable worker ceiling never widens approval and uncertainty halts undispatched children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentSettings, useSettings } from '../src/config/settings.js';
import { fixture, windows } from './helpers/checks.js';

test('one readiness worker stops scheduling after an uncertain child', windows, async t => {
  const previous = currentSettings();
  useSettings({ ...previous, maxReadinessConcurrency: 1 });
  t.after(() => useSettings(previous));
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
    async () => {
      calls++;
      return {
        reason: 'supervisor_lost',
        exitCode: null,
        exitConfirmed: false,
        stdout: '',
        stderr: '',
        outputTruncated: false,
      };
    },
  );
  assert.equal(calls, 1);
  assert.equal(checks[0]!.phase, 'recovery_required');
  assert.equal(checks[1]!.dispatch, 'not_requested');
  assert.ok(f.store.lease(f.workspace.id));
});
