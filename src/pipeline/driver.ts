// Entry point of a task driver: one process per task, normally running in the task's own Orca terminal.
// A lock file keeps a second driver for the same task from starting.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Orca } from '../orca/client.js';
import type { TaskStore } from '../store/task-store.js';
import { DriverCore, DriverStop, TaskAbandoned, type Log } from './driver-core.js';
import { finish, runPipeline } from './pipeline.js';

/** Run a task's driver until the task finishes or the driver must stop. Returns the process exit code. */
export async function drive(store: TaskStore, orca: Orca, log: Log): Promise<number> {
  const release = acquireLock(join(store.dir, 'driver.lock'));
  let finished = false;
  try {
    const core = new DriverCore(store, orca, log);
    if (core.state.finished) {
      log(`Task ${core.state.taskId} is already ${core.state.finished.outcome}.`);
      return 0;
    }
    core.record({
      type: 'driver.started',
      pid: process.pid,
      orcaVersion: await orca.version().catch(() => null),
      terminal: process.env.ORCA_TERMINAL_HANDLE ?? null,
    });
    log(`Driving ${core.state.taskId}: ${core.state.title}`);
    const code = await runToEnd(core, log);
    finished = code === 0 && core.state.finished !== null;
    return code;
  } finally {
    release();
    if (finished) await closeOwnTab(orca, log);
  }
}

/**
 * Close this driver's Orca tab once its task has finished, so no shell keeps the worktree open. A driver
 * that stopped keeps its tab, which shows why and where to rerun it. Closing ends this process.
 */
async function closeOwnTab(orca: Orca, log: Log): Promise<void> {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) return;
  log('Task finished; closing this tab.');
  await orca
    .closeTerminal(handle)
    .catch((error: unknown) => log(`Could not close this tab: ${(error as Error).message}`));
}

async function runToEnd(core: DriverCore, log: Log): Promise<number> {
  try {
    await runPipeline(core);
    return 0;
  } catch (error) {
    if (error instanceof TaskAbandoned) {
      await finish(core, 'abandoned', false, error.reason);
      return 0;
    }
    const reason =
      error instanceof DriverStop ? error.message : `Unexpected error: ${(error as Error).stack ?? String(error)}`;
    core.record({ type: 'driver.stopped', reason });
    log(`Stopped: ${reason}`);
    return 1;
  }
}

/** Take the task's driver lock, replacing it only when the recorded process no longer exists. */
function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = openSync(path, 'wx');
      writeSync(handle, String(process.pid));
      closeSync(handle);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(path, 'utf8'));
      if (processExists(owner))
        throw new Error(`Another driver (process ${owner}) is running this task.`, { cause: error });
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the driver lock at ${path}.`);
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
