// Owns the durable retry queue derived from explicit comparison decisions. Keeping requests in the
// existing journal preserves the frozen batch contract and never infers authorisation from failure.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import { parseBoundary } from '../process/boundary.js';
import { deepEqual } from './deep-equal.js';

const retrySchema = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), expected: z.string() });
const retryEventSchema = z.object({ retry: retrySchema });
/** One user-authorised attempt, bound to the exact task decision inspected when it was queued. */
export type ComparisonRetry = z.infer<typeof retrySchema>;

/** Pending explicit decisions and the one retry whose dispatch has already been requested. */
export interface ComparisonRetries {
  pending: ComparisonRetry[];
  active: ComparisonRetry | null;
}

/** A started request is never pending again, including after controller recovery. */
export function comparisonRetries(store: Store, id: string): ComparisonRetries {
  const result: ComparisonRetries = { pending: [], active: null };
  for (const event of store.comparisonEvents(id)) {
    if (!['comparison.retry_requested', 'comparison.retry_started', 'comparison.retry_finished'].includes(event.type))
      continue;
    const { retry } = parseBoundary(retryEventSchema, event.data, {
      kind: 'journal-record',
      source: 'comparison_events',
    });
    switch (event.type) {
      case 'comparison.retry_requested':
        result.pending.push(retry);
        break;
      case 'comparison.retry_started':
        if (result.active || !result.pending.some(item => deepEqual(item, retry)))
          throw new Error('Comparison retry journal has an inconsistent dispatch');
        result.pending = result.pending.filter(item => item.id !== retry.id);
        result.active = retry;
        break;
      case 'comparison.retry_finished':
        if (!deepEqual(result.active, retry))
          throw new Error('Comparison retry journal has an inconsistent settlement');
        result.active = null;
        break;
    }
  }
  return result;
}
