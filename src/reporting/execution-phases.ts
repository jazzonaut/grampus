// Owns read-only aggregation of measured execution phases. Nested phase totals intentionally overlap.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import { taskTurnUsage } from './task-usage.js';

const measurement = z.object({
  phase: z.string(),
  elapsedMs: z.number().finite().nonnegative(),
  outcome: z.enum(['completed', 'failed']),
});

const phaseLabels: Record<string, string> = {
  provider_startup: 'Provider startup',
  provider_turn: 'Provider turn',
  provider_shutdown: 'Provider shutdown',
  snapshot: 'Repository capture',
  input_fingerprint: 'Input fingerprints',
  command: 'Supervised commands',
};

/** Missing phase measurements remain absent; they are never inferred from provider wall time. */
export function executionPhases(store: Store, taskId: string) {
  const totals = new Map<string, { phase: string; observations: number; failed: number; elapsedMs: number }>();
  const executions = store.executions().filter(item => item.taskId === taskId);
  const sessions = new Set([
    ...executions.map(item => item.sessionId),
    ...taskTurnUsage(store, taskId).map(item => item.sessionId),
  ]);
  const executionRows = executions
    .flatMap(item => store.executionEvents(item.id))
    .filter(item => item.type === 'execution.phase_measured')
    .map(item => item.data);
  const sessionRows = [...sessions]
    .flatMap(id => store.sessionEvents(id))
    .filter(item => item.type === 'execution.phase_measured')
    .map(item => z.object({ data: measurement }).safeParse(item.data).data?.data);
  for (const value of [...executionRows, ...sessionRows]) {
    const parsed = measurement.safeParse(value);
    if (!parsed.success) continue;
    const row = parsed.data,
      total = totals.get(row.phase) ?? { phase: row.phase, observations: 0, failed: 0, elapsedMs: 0 };
    total.observations++;
    total.failed += Number(row.outcome === 'failed');
    total.elapsedMs += row.elapsedMs;
    totals.set(row.phase, total);
  }
  return [...totals.values()].map(row => ({ ...row, label: phaseLabels[row.phase] ?? row.phase }));
}
