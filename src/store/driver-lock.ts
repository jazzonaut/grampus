// The driver lock in a task's or comparison's folder: it makes one driver the only writer, and lets
// readers tell whether that driver is still alive. The file holds the owner's process id and a random
// token, and the owner touches it every `driverHeartbeatMs`. A lock is taken over when its process has
// ended or its heartbeat stopped (Windows reuses process ids, so a live id alone proves nothing). A
// driver checks its token before every write, so one whose lock was taken over stops without writing.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { currentSettings } from '../config/settings.js';

const lockName = 'driver.lock';

/** Another driver holds the lock now. The caller must stop without writing anything more. */
export class LockLost extends Error {}

export interface DriverLock {
  /** Throws `LockLost` once another driver has taken the lock. */
  assertHeld(): void;
  /** Stop the heartbeat and remove the lock, unless another driver holds it now. */
  release(): void;
}

/** A driver stop to show: recorded by the driver, or observed because its driver went missing. */
export interface DriverStopView {
  reason: string;
  at: string;
}

interface Holder {
  pid: number | null;
  /** Null for a lock written by an earlier build, which kept no heartbeat. */
  token: string | null;
  /** The last heartbeat: the file's modification time. */
  touchedAt: number;
}

/** Take the driver lock in `dir`, or throw when a live driver holds it. */
export function acquireDriverLock(dir: string): DriverLock {
  const path = join(dir, lockName);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = openSync(path, 'wx');
      writeSync(handle, JSON.stringify({ pid: process.pid, token }));
      closeSync(handle);
      return held(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(path);
      if (holder && ownerAlive(holder, Date.now()))
        throw new Error(`Another driver (process ${holder.pid ?? 'unknown'}) is running here.`, { cause: error });
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the driver lock at ${path}.`);
}

function held(path: string, token: string): DriverLock {
  const mine = () => readHolder(path)?.token === token;
  const heartbeat = setInterval(() => {
    if (!mine()) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // Removed between the check and the touch; the next write finds out.
    }
  }, currentSettings().driverHeartbeatMs);
  heartbeat.unref();
  return {
    assertHeld() {
      if (!mine()) throw new LockLost(`Another driver took over ${path}; this one stops without writing.`);
    },
    release() {
      clearInterval(heartbeat);
      if (mine()) rmSync(path, { force: true });
    },
  };
}

/** Whether a live driver holds the lock in `dir`, judged by its heartbeat as readers see it. */
export function driverAlive(dir: string, now = Date.now()): boolean {
  const holder = readHolder(join(dir, lockName));
  return holder !== null && seenAlive(holder, now);
}

/** The lock's holder as readers see it, or null when no driver holds the lock in `dir`. */
export function driverHeartbeat(
  dir: string,
  now = Date.now(),
): { pid: number | null; touchedAt: string; alive: boolean } | null {
  const holder = readHolder(join(dir, lockName));
  return holder
    ? { pid: holder.pid, touchedAt: new Date(holder.touchedAt).toISOString(), alive: seenAlive(holder, now) }
    : null;
}

/**
 * The driver stop readers show: the one the driver recorded, or one observed because the driver is gone
 * without recording why (killed, its terminal closed, the machine restarted). `at` is when the absence
 * became observable, which does not move, so `grampus wait --after` reports it once.
 */
export function observedStop(
  dir: string,
  view: { finished: boolean; lastStop: DriverStopView | null; createdAt: string; lastEventAt: string },
  now = Date.now(),
): DriverStopView | null {
  if (view.finished) return null;
  if (view.lastStop) return view.lastStop;
  const staleMs = currentSettings().driverStaleMs;
  const holder = readHolder(join(dir, lockName));
  if (holder) {
    if (seenAlive(holder, now)) return null;
    return {
      reason: `The driver has not been seen since ${new Date(holder.touchedAt).toISOString()}: its process ended without recording why, or it hangs.`,
      at: new Date(holder.touchedAt + staleMs).toISOString(),
    };
  }
  // No lock: the driver has not started yet, or it ended without recording why.
  const at = Math.max(Date.parse(view.createdAt) + staleMs, Date.parse(view.lastEventAt));
  if (at > now) return null;
  return { reason: 'The driver is not running and did not record why.', at: new Date(at).toISOString() };
}

/** A folded task or comparison state with the stop readers should show in place of the recorded one. */
export function withObservedStop<S extends { finished: unknown; lastStop: DriverStopView | null; createdAt: string }>(
  state: S,
  dir: string,
  events: readonly { at: string }[],
  now = Date.now(),
): S {
  const lastEventAt = events.at(-1)?.at ?? state.createdAt;
  const view = { finished: state.finished !== null, lastStop: state.lastStop, createdAt: state.createdAt, lastEventAt };
  return { ...state, lastStop: observedStop(dir, view, now) };
}

/**
 * Whether the owner may still be writing, as a driver about to take over judges it. A dead process
 * frees the lock at once.
 */
function ownerAlive(holder: Holder, now: number): boolean {
  const running = holder.pid !== null && processExists(holder.pid);
  if (holder.token === null) return holder.pid === null ? fresh(holder, now) : running;
  return running && fresh(holder, now);
}

/**
 * Whether readers count the owner as alive. They go by the heartbeat alone, so the time a stop is
 * reported from is fixed by the last heartbeat; a lock without one stays alive while its process runs.
 */
function seenAlive(holder: Holder, now: number): boolean {
  if (holder.token === null && holder.pid !== null) return processExists(holder.pid);
  return fresh(holder, now);
}

function fresh(holder: Holder, now: number): boolean {
  return now - holder.touchedAt <= currentSettings().driverStaleMs;
}

/** The lock's owner, or null without a lock. A lock still being written has neither id nor token. */
function readHolder(path: string): Holder | null {
  let text: string;
  let touchedAt: number;
  try {
    text = readFileSync(path, 'utf8');
    touchedAt = statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Being written, or torn by a crash.
  }
  if (typeof parsed === 'number') return { pid: parsed, token: null, touchedAt };
  if (parsed && typeof parsed === 'object') {
    const { pid, token } = parsed as Record<string, unknown>;
    return {
      pid: typeof pid === 'number' ? pid : null,
      token: typeof token === 'string' ? token : null,
      touchedAt,
    };
  }
  return { pid: null, token: null, touchedAt };
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
