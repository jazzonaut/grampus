// Owns the bounded pool of guided runners: how many guided tasks may own a runner at once
// (`maxConcurrentTasks`), the typed refusal when the pool is full, and the pool view the dashboard and
// CLI show. Claiming, fencing, releasing and recovering ownership stay in controller.ts.
//
// A full pool refuses the claim; nothing is queued. Grampus has no background scheduler, and a queued
// task would have to start without a click whenever a slot freed, possibly long after the person left.
import type { Store } from '../../persistence/store.js';
import { currentSettings } from '../../config/settings.js';

/** How full the runner pool is. */
export interface RunnerPool {
  /** Guided tasks that own a runner now, including owners kept for recovery after an uncertain stop. */
  active: number;
  /** The `maxConcurrentTasks` setting this process runs with. */
  limit: number;
  /** The owning task ids, in creation order. */
  owners: string[];
}

/** The current pool, read from the journal's indexed runner column. */
export function runnerPool(store: Store): RunnerPool {
  const owners = store.runnerOwners();
  return { active: owners.length, limit: currentSettings().maxConcurrentTasks, owners };
}

/**
 * A claim that would start work while `maxConcurrentTasks` guided tasks already own a runner. The task
 * is unchanged and nothing is queued: continue it again once a slot is free. The dashboard maps it to 409.
 */
export class RunnerPoolFullError extends Error {
  readonly pool: RunnerPool;
  constructor(pool: RunnerPool) {
    super(
      `${pool.active} of ${pool.limit} guided tasks are already running (maxConcurrentTasks ${pool.limit}): ${pool.owners.join(', ')}. ` +
        'Wait for one to finish, or stop or recover it, then continue this task again. Nothing was queued.',
    );
    this.name = 'RunnerPoolFullError';
    this.pool = pool;
  }
}

/**
 * Refuses with {@link RunnerPoolFullError} unless another guided task may start work now. Called inside
 * the claim's `BEGIN IMMEDIATE` transaction, so counting and claiming are atomic across processes; the
 * dashboard also calls it before starting a worker, to answer 409 at once.
 */
export function assertRunnerAvailable(store: Store): void {
  const pool = runnerPool(store);
  if (pool.active >= pool.limit) throw new RunnerPoolFullError(pool);
}
