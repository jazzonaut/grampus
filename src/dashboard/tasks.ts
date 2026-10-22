// Reading task logs for the dashboard. Folds are cached by log size, which only grows (the log is
// append-only), so a page refresh rereads only the tasks that changed. The watcher compares the same
// sizes to tell live clients which tasks changed.
import { existsSync, statSync } from 'node:fs';
import type { StoredEvent } from '../domain/events.js';
import { foldEvents, type TaskState } from '../pipeline/state.js';
import { ComparisonStore, listComparisonIds } from '../compare/comparison.js';
import { driverAlive, withObservedStop } from '../store/driver-lock.js';
import { listTaskIds, TaskStore } from '../store/task-store.js';

export interface LoadedTask {
  store: TaskStore;
  events: StoredEvent[];
  state: TaskState;
}

/** Cached reads of every task in one data directory. */
export class TaskReader {
  private readonly cache = new Map<string, { size: number; task: LoadedTask }>();

  constructor(readonly dataDir: string) {}

  /**
   * One task, read again only when its log grew. Throws for an unknown or unreadable task. A driver that
   * went missing without recording why shows as stopped; that is checked on every load, since it leaves
   * the log unchanged.
   */
  load(taskId: string): LoadedTask {
    const store = TaskStore.open(this.dataDir, taskId);
    const size = statSync(store.eventsPath).size;
    const cached = this.cache.get(taskId);
    const task = cached?.size === size ? cached.task : this.read(store);
    if (cached?.size !== size) this.cache.set(taskId, { size, task });
    return { ...task, state: withObservedStop(task.state, store.dir, task.events) };
  }

  private read(store: TaskStore): LoadedTask {
    const events = store.events();
    return { store, events, state: foldEvents(events) };
  }

  /** Every task, with the ids of folders whose logs could not be read. */
  loadAll(): { tasks: LoadedTask[]; unreadable: { taskId: string; error: string }[] } {
    const tasks: LoadedTask[] = [];
    const unreadable: { taskId: string; error: string }[] = [];
    for (const taskId of listTaskIds(this.dataDir)) {
      try {
        tasks.push(this.load(taskId));
      } catch (error) {
        unreadable.push({ taskId, error: (error as Error).message });
      }
    }
    return { tasks, unreadable };
  }
}

/**
 * A task's change signature: the sizes of its event log and command queue, and whether its driver is
 * alive, so a driver that dies without writing anything still updates the page.
 */
function signature(dataDir: string, taskId: string): string {
  return storeSignature(TaskStore.open(dataDir, taskId));
}

/** A comparison's change signature, made like a task's. */
function comparisonSignature(dataDir: string, comparisonId: string): string {
  return storeSignature(ComparisonStore.open(dataDir, comparisonId));
}

function storeSignature(store: { dir: string; eventsPath: string; commandsPath: string }): string {
  const commands = existsSync(store.commandsPath) ? statSync(store.commandsPath).size : 0;
  return `${statSync(store.eventsPath).size}:${commands}:${driverAlive(store.dir) ? 'alive' : 'gone'}`;
}

/**
 * Polls task logs and reports the ids of tasks that appeared, disappeared or grew. Polling rather than
 * file watching keeps behaviour the same on every platform and network drive.
 */
export class TaskWatcher {
  private signatures = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(changed: string[]) => void>();

  constructor(
    private readonly dataDir: string,
    private readonly intervalMs: number,
  ) {}

  /** Listen for changes; the returned function stops listening. Polling runs only while someone listens. */
  subscribe(listener: (changed: string[]) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.signatures = this.scan();
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private scan(): Map<string, string> {
    const next = new Map<string, string>();
    // Comparisons are reported as `cmp:<id>`, so pages can tell them from tasks.
    for (const comparisonId of listComparisonIds(this.dataDir)) {
      try {
        next.set(`cmp:${comparisonId}`, comparisonSignature(this.dataDir, comparisonId));
      } catch {
        // Reported by the comparison list.
      }
    }
    for (const taskId of listTaskIds(this.dataDir)) {
      try {
        next.set(taskId, signature(this.dataDir, taskId));
      } catch {
        // An unreadable task is reported by the task list, not by the watcher.
      }
    }
    return next;
  }

  private poll(): void {
    const next = this.scan();
    const changed = [...new Set([...next.keys(), ...this.signatures.keys()])].filter(
      taskId => next.get(taskId) !== this.signatures.get(taskId),
    );
    this.signatures = next;
    if (changed.length) for (const listener of this.listeners) listener(changed);
  }
}
