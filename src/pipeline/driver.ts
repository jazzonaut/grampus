// Entry point of a task driver: one process per task, normally running in the task's own Orca terminal.
// The driver lock keeps a second driver for the same task from starting, and stops this one from writing
// if another driver took the lock over.
import { installedBuild } from '../install/installation.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { currentSettings } from '../config/settings.js';
import type { Orca } from '../orca/client.js';
import { acquireDriverLock, LockLost } from '../store/driver-lock.js';
import type { TaskStore } from '../store/task-store.js';
import { DriverCore, DriverStop, TaskAbandoned, type Log } from './driver-core.js';
import { finish, runPipeline } from './pipeline.js';
import { measureDispatches } from '../measure/usage.js';

/** Run a task's driver until the task finishes or the driver must stop. Returns the process exit code. */
export async function drive(store: TaskStore, orca: Orca, log: Log): Promise<number> {
  const lock = acquireDriverLock(store.dir);
  store.fenceWith(() => lock.assertHeld());
  let finished = false;
  try {
    const core = new DriverCore(store, orca, log);
    if (core.state.finished) {
      log(`Task ${core.state.taskId} is already ${core.state.finished.outcome}.`);
      return 0;
    }
    const build = installedBuild()?.build;
    core.record({
      type: 'driver.started',
      pid: process.pid,
      orcaVersion: await orca.version().catch(() => null),
      terminal: process.env.ORCA_TERMINAL_HANDLE ?? null,
      ...(build ? { build } : {}),
    });
    log(`Driving ${core.state.taskId}: ${core.state.title}`);
    const code = await runToEnd(core, log);
    finished = code === 0 && core.state.finished !== null;
    return code;
  } finally {
    lock.release();
    if (finished) await closeOwnTab(orca, log);
  }
}

/** Reopen a completed task briefly for queued explanation or question workers. */
export async function driveReview(store: TaskStore, orca: Orca, log: Log): Promise<number> {
  const deadline = Date.now() + currentSettings().driverStaleMs;
  let lock;
  for (;;) {
    try {
      lock = acquireDriverLock(store.dir);
      break;
    } catch (error) {
      if (!String((error as Error).message).startsWith('Another driver') || Date.now() >= deadline) throw error;
      await sleep(currentSettings().orcaRetryDelayMs);
    }
  }
  store.fenceWith(() => lock.assertHeld());
  let core: DriverCore | null = null;
  let completed = false;
  try {
    core = new DriverCore(store, orca, log);
    if (!core.state.finished) throw new Error('The main driver still owns this task.');
    core.record({
      type: 'driver.started',
      pid: process.pid,
      orcaVersion: await orca.version().catch(() => null),
      terminal: process.env.ORCA_TERMINAL_HANDLE ?? null,
    });
    const runId = core.state.runId;
    if (runId) await core.repeatUncertain(() => orca.useRun(runId));
    await core.processReviewCommands();
    await core.releaseWorkers();
    core.record({ type: 'usage.recorded', measurements: await measureDispatches(core.state, orca) });
    completed = true;
    return 0;
  } catch (error) {
    if (!core) throw error;
    return recordStop(core, error, log);
  } finally {
    lock.release();
    if (completed) await closeOwnTab(orca, log);
  }
}

/**
 * Close this driver's Orca tab once its task has finished, so no shell keeps the worktree open. A driver
 * that stopped keeps its tab, which shows why and where to rerun it. Closing ends this process.
 */
export async function closeOwnTab(orca: Pick<Orca, 'closeTerminal'>, log: Log): Promise<void> {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) return;
  log('Task finished; closing this tab.');
  await orca
    .closeTerminal(handle)
    .catch((error: unknown) => log(`Could not close this tab: ${(error as Error).message}`));
}

async function runToEnd(core: DriverCore, log: Log): Promise<number> {
  try {
    try {
      await runPipeline(core);
    } catch (error) {
      if (!(error instanceof TaskAbandoned)) throw error;
      await finish(core, error.outcome, false, error.reason);
    }
    return 0;
  } catch (error) {
    return recordStop(core, error, log);
  }
}

/** Both driver entry points preserve the failure evidence and leave the terminal available to resume. */
function recordStop(core: DriverCore, error: unknown, log: Log): number {
  // The log belongs to the driver that took over; even the reason for stopping is not ours to record.
  if (error instanceof LockLost) {
    log(`Stopped: ${error.message}`);
    return 1;
  }
  const reason =
    error instanceof DriverStop ? error.message : `Unexpected error: ${(error as Error).stack ?? String(error)}`;
  core.record({ type: 'driver.stopped', reason });
  log(`Stopped: ${reason}`);
  return 1;
}
