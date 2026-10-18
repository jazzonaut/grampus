import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readReceipt, requireDeadController } from '../src/verification/check-recovery.js';
import type { ExecutionLease } from '../src/execution/execution-state.js';
import { currentProcessStartedAt, inspectProcess } from '../src/process/process-identity.js';
import { runCheckProcess } from '../src/process/check-process.js';

const windows = { skip: process.platform !== 'win32' };
function startTime(): string {
  const powershell = resolve(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}
function lease(controllerStartedAt: string | null = null): ExecutionLease {
  return {
    executionId: 'execution',
    sessionId: 'session',
    runId: 'run',
    controllerPid: process.pid,
    controllerStartedAt,
    host: hostname(),
    kind: 'check',
  };
}

test('Windows process observations preserve exact creation times and distinguish missing from unknown', windows, () => {
  const current = startTime();
  assert.deepEqual(inspectProcess(process.pid), { state: 'present', startedAt: current });
  assert.equal(currentProcessStartedAt(), current);
  assert.deepEqual(inspectProcess(2147483647), { state: 'absent' });
  for (const pid of [0, -1, NaN, 1.5]) assert.deepEqual(inspectProcess(pid), { state: 'unknown' });
});

test('controller recovery distinguishes a replacement process from its recorded owner', windows, () => {
  const current = startTime();
  assert.throws(() => requireDeadController(lease(current)), /controller is still alive/);
  // Model PID reuse deterministically: a live PID now has a different creation time.
  assert.doesNotThrow(() => requireDeadController(lease((BigInt(current) - 1n).toString())));
});

test('unknown and malformed controller identities keep recovery conservative', windows, () => {
  assert.throws(() => requireDeadController(lease()), /controller is still alive/);
  for (const identity of ['', 'unknown', '0', '-1']) {
    assert.throws(() => requireDeadController(lease(identity)), /controller is still alive/);
  }
  assert.throws(() => requireDeadController({ ...lease(), host: 'another-host' }), /execution host/);
});

test(
  'unavailable identity inspection cannot release a live controller with a different saved creation time',
  windows,
  t => {
    const identity = (BigInt(startTime()) - 1n).toString();
    const original = process.env.SystemRoot;
    t.after(() => {
      if (original === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = original;
    });
    process.env.SystemRoot = join(tmpdir(), 'grampus-deliberately-missing-windows');
    assert.deepEqual(inspectProcess(process.pid), { state: 'unknown' });
    assert.throws(() => requireDeadController(lease(identity)), /controller is still alive/);
  },
);

test('a terminal receipt permits a recycled supervisor PID but rejects its original live owner', windows, t => {
  const directory = mkdtempSync(join(tmpdir(), 'grampus-receipt-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipt = { directory, checkId: 'check', token: 'token' };
  const current = startTime();
  const value = {
    protocol: 1,
    checkId: receipt.checkId,
    token: receipt.token,
    exitConfirmed: true,
    supervisorPid: process.pid,
    supervisorStartedAt: current,
    toolPid: 123,
    exitCode: 1,
    reason: 'interrupted',
  };
  const save = (changes: Record<string, unknown>) =>
    writeFileSync(join(directory, 'completion.json'), JSON.stringify({ ...value, ...changes }));
  save({});
  assert.throws(() => readReceipt(receipt, process.pid, 123), /Supervisor is still alive/);
  save({ supervisorStartedAt: (BigInt(current) - 1n).toString() });
  assert.equal(readReceipt(receipt, process.pid, 123).reason, 'interrupted');
  for (const changes of [
    { token: 'foreign' },
    { toolPid: 456 },
    { exitConfirmed: false },
    { supervisorStartedAt: 'unknown' },
  ]) {
    save(changes);
    assert.throws(() => readReceipt(receipt, process.pid, 123), /receipt|Supervisor/);
  }
  save({ supervisorStartedAt: undefined });
  assert.throws(() => readReceipt(receipt, process.pid, 123), /Supervisor is still alive/);
});

test(
  'the real supervisor receipt retains the creation time observed while that supervisor was alive',
  windows,
  async t => {
    const directory = mkdtempSync(join(tmpdir(), 'grampus-native-identity-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const receipt = { directory, checkId: 'identity-check', token: 'identity-token' };
    let supervisorPid = 0,
      toolPid = 0;
    let observedStartedAt: string | null = null;
    const result = await runCheckProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1500)'],
      cwd: process.cwd(),
      timeoutMs: 10000,
      receipt,
      started: (kind, pid) => {
        if (kind === 'supervisor') supervisorPid = pid;
        else {
          toolPid = pid;
          const observed = inspectProcess(supervisorPid);
          if (observed.state === 'present') observedStartedAt = observed.startedAt;
        }
      },
    });
    assert.equal(result.reason, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.ok(observedStartedAt, 'The running supervisor must have an observable creation time');
    const saved = JSON.parse(readFileSync(join(directory, 'completion.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(saved['supervisorStartedAt'], observedStartedAt);
    assert.equal(readReceipt(receipt, supervisorPid, toolPid).reason, 'exited');
  },
);
