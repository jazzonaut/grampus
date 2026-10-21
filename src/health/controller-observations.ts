// Owns cached, display-only controller identity observations. It never changes leases or recovers work.
import { hostname } from 'node:os';
import { stallLimits } from '../config/limits.js';
import type { Owner } from '../orchestration/guided/state.js';
import { inspectProcessAsync, type ProcessObservation } from '../process/process-identity.js';

/** Unknown includes remote hosts and unavailable identity inspection, which never prove an owner dead. */
export type ControllerState = 'present' | 'absent' | 'unknown';

const key = (owner: Owner) =>
  JSON.stringify([
    owner.host,
    owner.controllerPid,
    owner.controllerStartedAt,
    owner.controllerStartedAt === null ? owner.token : null,
  ]);

/** Observations are shared across requests and tokens for the same exact host/PID/creation time. */
export class ControllerObservations {
  private readonly entries = new Map<string, { at: number; state: ControllerState; pending: Promise<void> | null }>();

  constructor(
    private readonly inspect: (pid: number) => Promise<ProcessObservation> = inspectProcessAsync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns only a fresh observation bound to this owner's original process identity. */
  state(owner: Owner): ControllerState {
    const entry = this.entries.get(key(owner));
    return entry && (entry.state === 'absent' || this.now() - entry.at < stallLimits.scanIntervalMs)
      ? entry.state
      : 'unknown';
  }

  /** Starts at most one non-blocking inspection per identity per scan interval; prunes departed owners. */
  async refresh(owners: readonly Owner[]): Promise<void> {
    const retained = new Set(owners.map(key));
    for (const id of this.entries.keys()) if (!retained.has(id)) this.entries.delete(id);
    await Promise.all(owners.map(owner => this.observe(owner)));
  }

  private observe(owner: Owner): Promise<void> {
    if (owner.host !== hostname()) return Promise.resolve();
    const id = key(owner),
      cached = this.entries.get(id);
    // An original process proven gone cannot return. A replacement controller has another identity.
    if (cached?.state === 'absent') return Promise.resolve();
    if (cached?.pending) return cached.pending;
    if (cached && this.now() - cached.at < stallLimits.scanIntervalMs) return Promise.resolve();
    const entry = { at: -Infinity, state: 'unknown' as ControllerState, pending: null as Promise<void> | null };
    this.entries.set(id, entry);
    entry.pending = this.inspect(owner.controllerPid)
      .then(
        observation => {
          entry.state =
            observation.state === 'present' &&
            owner.controllerStartedAt !== null &&
            observation.startedAt !== owner.controllerStartedAt
              ? 'absent'
              : observation.state;
        },
        () => {
          entry.state = 'unknown';
        },
      )
      .finally(() => {
        entry.at = this.now();
        entry.pending = null;
      });
    return entry.pending;
  }
}
