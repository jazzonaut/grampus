// Owns what the view model needs from the running dashboard beyond the journal: the in-memory action
// workers, the current stalls and the available quality passes. Pure view-model functions take this and
// the store, and return DTOs; nothing here writes.
import type { QualityPassDefinition } from '../../domain/quality-passes.js';
import type { Stall } from '../../health/stalls.js';
import type { StallV1 } from '../api-types.js';
import { providerLabel } from './status.js';

/** An action worker this dashboard started (the server's in-memory job). */
export interface JobView {
  running: boolean;
  error: string | null;
  action: string;
  startedAt: string;
  settledAt: string | null;
}

/** The dashboard state the view model reads besides the journal. */
export interface ViewContext {
  /** The worker for a task or planning conversation, if this dashboard started one recently. */
  job(id: string): JobView | null;
  /** The current stall of a guided task, if any. */
  stall(id: string): Stall | null;
  /** Every quality pass a revision may select. */
  qualityPasses: readonly QualityPassDefinition[];
}

/** A stall in UI language. The message is time-free so it can be cached; clients count minutes from `lastActivityAt`. */
export function stallView(stall: Stall | null): StallV1 | null {
  if (!stall) return null;
  const owner =
    stall.owner.kind === 'check'
      ? `check ${stall.owner.label}`
      : `${stall.owner.label === 'codex' || stall.owner.label === 'claude' ? providerLabel(stall.owner.label) : stall.owner.label} session`;
  return {
    since: stall.since,
    lastActivityAt: stall.lastActivityAt,
    owner,
    message: `No activity from the ${owner} since its last recorded activity. Nothing has been stopped: wait if this step is slow, or choose Stop now if it is hung.`,
  };
}
