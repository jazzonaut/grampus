// Owns locating a focused probe receipt, never inferring acceptance from it.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';

const probeSchema = z.object({ implementationId: z.string(), failedCheckId: z.string(), checkId: z.string() });

/** Only a controller-recorded probe of the current failed check and implementation is relevant. */
export function latestRepairProbe(store: Store, implementationId: string, failedCheckId: string) {
  const run = store.implementation(implementationId);
  const event = store.executionEvents(run.executionId, ['implementation.repair_probed']).findLast(item => {
    const data = probeSchema.safeParse(item.data).data;
    return data?.implementationId === implementationId && data.failedCheckId === failedCheckId;
  });
  const data = event ? probeSchema.parse(event.data) : null;
  if (!data) return null;
  const check = store.check(data.checkId);
  return check.executionId === run.executionId ? check : null;
}
