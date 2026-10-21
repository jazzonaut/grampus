// Display liveness must distinguish a recycled PID and coalesce inspections without granting recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { ControllerObservations } from '../src/health/controller-observations.js';
import { inspectProcess, inspectProcessAsync } from '../src/process/process-identity.js';
import { stallLimits } from '../src/config/limits.js';

test('controller observations share in-flight work, expire live samples and keep exact process death terminal', async () => {
  let calls = 0,
    now = 0,
    creation = 'original';
  const observations = new ControllerObservations(
    async () => {
      calls++;
      return { state: 'present', startedAt: creation };
    },
    () => now,
  );
  const owner = { host: hostname(), token: 'run', controllerPid: process.pid, controllerStartedAt: 'original' };
  assert.equal(observations.state(owner), 'unknown');
  await Promise.all([observations.refresh([owner]), observations.refresh([owner])]);
  assert.equal(calls, 1);
  assert.equal(observations.state(owner), 'present');
  now += stallLimits.scanIntervalMs;
  creation = 'replacement';
  await observations.refresh([owner]);
  assert.equal(observations.state(owner), 'absent');
  now += stallLimits.scanIntervalMs;
  await observations.refresh([owner]);
  assert.equal(calls, 2, 'an original process proven gone cannot return');
  const replacement = { ...owner, token: 'next', controllerStartedAt: creation };
  assert.equal(observations.state(replacement), 'unknown');
  await observations.refresh([replacement]);
  assert.equal(observations.state(replacement), 'present');
});

test('unknown and remote controller observations never prove absence', async () => {
  let calls = 0;
  const observations = new ControllerObservations(async () => {
    calls++;
    return { state: 'unknown' };
  });
  const owner = { host: hostname(), token: 'run', controllerPid: process.pid, controllerStartedAt: null };
  const remote = { ...owner, host: 'another-host' };
  await observations.refresh([owner, remote]);
  assert.equal(calls, 1);
  assert.equal(observations.state(owner), 'unknown');
  assert.equal(observations.state(remote), 'unknown');
});

test(
  'asynchronous native process inspection preserves the same exact identity proof as recovery',
  { skip: process.platform !== 'win32' },
  async () => {
    const before = inspectProcess(process.pid);
    assert.equal(before.state, 'present');
    assert.deepEqual(await inspectProcessAsync(process.pid), before);
  },
);
