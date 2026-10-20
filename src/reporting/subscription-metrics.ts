// Owns subscription observations in the journal; absence of provider telemetry stays unknown.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { TurnUsage } from './task-usage.js';
const observation = z.object({
  runId: z.string(),
  data: z.object({ provider: z.string(), status: z.string().optional() }),
});

/** Counts only provider-reported rejections, without guessing from error-message prose. */
export function subscriptionMetrics(store: Store, turns: TurnUsage[]) {
  const samples = [...new Set(turns.map(turn => turn.sessionId))].flatMap(sessionId =>
    store.sessionEvents(sessionId, ['subscription.observed']).map(event => ({ sessionId, event })),
  );
  const rejected = new Set(
    samples.flatMap(({ sessionId, event }) => {
      const parsed = observation.safeParse(event.data);
      return parsed.data?.data.status === 'rejected' ? [`${sessionId}:${parsed.data.runId}`] : [];
    }),
  );
  const measured = samples.some(({ event }) => observation.safeParse(event.data).data?.data.status !== undefined);
  return { observations: samples.length, rejectedTurns: measured ? rejected.size : null, allowanceConsumed: null };
}
