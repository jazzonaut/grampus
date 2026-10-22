// The driver lock: one driver per task, a heartbeat readers can see, and fencing a driver whose lock
// another driver took.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentSettings } from '../src/config/settings.js';
import { acquireDriverLock, driverAlive, LockLost, observedStop } from '../src/store/driver-lock.js';
import { useTestSettings } from './helpers/task-fixture.js';

/** A process id that is not running: far above any id Windows or Linux hands out. */
const deadPid = 2 ** 31 - 2;

function folder(): { dir: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), 'grampus-lock-'));
  return { dir, lock: join(dir, 'driver.lock') };
}

function age(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

test('a second driver is refused while the first one holds the lock', () => {
  useTestSettings();
  const { dir } = folder();
  const first = acquireDriverLock(dir);
  assert.throws(() => acquireDriverLock(dir), /Another driver \(process \d+\) is running/);
  assert.ok(driverAlive(dir));
  first.release();
  assert.ok(!driverAlive(dir));
  acquireDriverLock(dir).release();
});

test('a lock whose process ended, or whose heartbeat stopped, is taken over', () => {
  useTestSettings();
  const { dir, lock } = folder();
  writeFileSync(lock, JSON.stringify({ pid: deadPid, token: 'crashed' }));
  acquireDriverLock(dir).release();

  // After a restart Windows may give the dead driver's process id to another program.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'reused-pid' }));
  age(lock, currentSettings().driverStaleMs + 1000);
  assert.ok(!driverAlive(dir), 'readers see the driver as gone');
  acquireDriverLock(dir).release();
});

test('a driver whose lock was taken stops writing and leaves the new lock alone', () => {
  useTestSettings();
  const { dir, lock } = folder();
  const held = acquireDriverLock(dir);
  held.assertHeld();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'another-driver' }));
  assert.throws(() => held.assertHeld(), LockLost);
  held.release();
  assert.match(readFileSync(lock, 'utf8'), /another-driver/);
});

test('the heartbeat keeps a busy driver alive for readers', async () => {
  useTestSettings({ driverHeartbeatMs: 10, driverStaleMs: 200 });
  const { dir, lock } = folder();
  const held = acquireDriverLock(dir);
  age(lock, 10_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(driverAlive(dir), 'the heartbeat touched the lock again');
  held.release();
  assert.ok(!existsSync(lock));
});

test('readers see a driver that ended without recording why as stopped', () => {
  useTestSettings({ driverStaleMs: 60_000 });
  const { dir, lock } = folder();
  const now = Date.now();
  const createdAt = new Date(now - 3_600_000).toISOString();
  const lastEventAt = new Date(now - 600_000).toISOString();
  const view = { finished: false, lastStop: null, createdAt, lastEventAt };

  const recorded = { reason: 'Orca refused', at: lastEventAt };
  assert.deepEqual(observedStop(dir, { ...view, lastStop: recorded }, now), recorded, 'a recorded stop wins');
  assert.equal(observedStop(dir, { ...view, finished: true }, now), null, 'a finished task has no driver');

  const fresh = { ...view, createdAt: new Date(now - 1000).toISOString(), lastEventAt: createdAt };
  assert.equal(observedStop(dir, fresh, now), null, 'a new task gets time to start its driver');

  const gone = observedStop(dir, view, now);
  assert.match(gone?.reason ?? '', /not running/);
  assert.equal(gone?.at, lastEventAt, 'reported from its last event, so wait --after sees it once');

  const held = acquireDriverLock(dir);
  assert.equal(observedStop(dir, view, now), null, 'a driver with a fresh heartbeat is running');
  held.release();

  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'hung' }));
  const touched = now - 120_000;
  utimesSync(lock, new Date(touched), new Date(touched));
  const silent = observedStop(dir, view, now);
  assert.match(silent?.reason ?? '', /has not been seen since/);
  assert.equal(silent?.at, new Date(touched + 60_000).toISOString(), 'reported from when it went missing');
});
