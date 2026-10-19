// Owns stall detection: surfacing a running provider session or check of a guided task that has been
// silent for `stallWarningMs`. Guided turns have no deadline, so a hung provider would otherwise hold the
// runner with nothing on screen to say so. Detection only observes: it never stops, interrupts or
// recovers anything. The user decides, with the existing Stop control.
//
// Activity is anything journaled for the running work (any session event, including output, usage and
// tool events, or any execution event of a check) and, for a check, its output logs growing on disk.
// One `guided.stall_detected` event is appended per silence: the event names the activity it measured
// from, so a later scan of the same silence does not repeat it, and new activity starts a new silence.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActiveWork, Store } from '../persistence/store.js';
import { currentSettings } from '../config/settings.js';

/** What has gone silent. `label` is the session's provider or the check's name. */
export interface StallOwner {
  kind: 'session' | 'check';
  id: string;
  label: string;
}

/** A possibly stalled task, as the task summary and poll show it. */
export interface Stall {
  /** When the silence crossed the threshold: last activity plus `stallWarningMs`. */
  since: string;
  lastActivityAt: string;
  owner: StallOwner;
}

/** The journal event type written once per detected silence. */
export const stallEventType = 'guided.stall_detected';

const minuteMs = 60_000;

const stallEventSchema = z.object({ lastActivityAt: z.string(), owner: z.object({ id: z.string() }) });

/** The latest activity of one piece of running work, in milliseconds, or null when nothing is known. */
function lastActivity(work: ActiveWork): number | null {
  const times = work.lastEventAt ? [Date.parse(work.lastEventAt)] : [];
  if (work.directory)
    for (const stream of ['stdout', 'stderr'])
      try {
        times.push(statSync(join(work.directory, stream)).mtimeMs);
      } catch {
        /* The log does not exist yet; journaled events still count. */
      }
  const known = times.filter(Number.isFinite);
  return known.length ? Math.max(...known) : null;
}

function describe(owner: StallOwner): string {
  if (owner.kind === 'check') return `check ${owner.label}`;
  return `${owner.label === 'codex' ? 'Codex' : owner.label === 'claude' ? 'Claude' : owner.label} session`;
}

/**
 * Scans the journal for silent running work. The dashboard server owns one and scans every
 * `stallLimits.scanIntervalMs`; tests inject `now` and call `scan` directly.
 */
export class StallWatchdog {
  private current = new Map<string, Stall>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Recompute every stall at `now()` and journal each new one. Returns the stalls by task id. A task
   * with several silent items reports the one silent the longest.
   */
  scan(thresholdMs: number = currentSettings().stallWarningMs): ReadonlyMap<string, Stall> {
    const now = this.now();
    const stalls = new Map<string, Stall>();
    for (const work of this.store.activeGuidedWork()) {
      const last = lastActivity(work);
      if (last === null || now - last < thresholdMs) continue;
      const existing = stalls.get(work.taskId);
      if (existing && Date.parse(existing.lastActivityAt) <= last) continue;
      stalls.set(work.taskId, {
        since: new Date(last + thresholdMs).toISOString(),
        lastActivityAt: new Date(last).toISOString(),
        owner: { kind: work.kind, id: work.id, label: work.label },
      });
    }
    for (const [taskId, stall] of stalls) this.record(taskId, stall, now);
    this.current = stalls;
    return stalls;
  }

  /** The stall found by the latest scan for a task, or null. */
  stall(taskId: string): Stall | null {
    return this.current.get(taskId) ?? null;
  }

  /** Append the stall event unless the latest one already describes this same silence. */
  private record(taskId: string, stall: Stall, now: number): void {
    this.store.transaction(() => {
      const previous = stallEventSchema.safeParse(this.store.events(taskId, [stallEventType]).at(-1)?.data);
      if (
        previous.success &&
        previous.data.owner.id === stall.owner.id &&
        previous.data.lastActivityAt === stall.lastActivityAt
      )
        return;
      const task = z.looseObject({ version: z.number() }).parse(this.store.get(taskId));
      const minutes = Math.floor((now - Date.parse(stall.lastActivityAt)) / minuteMs);
      this.store.append(taskId, task.version, stallEventType, {
        ...stall,
        note: `No activity from the ${describe(stall.owner)} for ${minutes} min. Nothing was stopped; request a stop if it is hung.`,
      });
    });
  }
}
