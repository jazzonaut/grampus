// Owns monotonic execution-phase measurements. These observations never establish success evidence.
import { performance } from 'node:perf_hooks';
import type { Store } from '../persistence/store.js';

/** Nested phases overlap; consumers must not add them to workflow elapsed time. */
export type ExecutionPhase =
  'provider_startup' | 'provider_turn' | 'provider_shutdown' | 'snapshot' | 'input_fingerprint' | 'command';

/** Measures one settled asynchronous operation, including failures, without changing its result. */
export async function measurePhase<T>(
  store: Store,
  executionId: string,
  phase: ExecutionPhase,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome = 'failed';
  try {
    const value = await operation();
    outcome = 'completed';
    return value;
  } finally {
    store.appendExecution(executionId, 'execution.phase_measured', {
      phase,
      elapsedMs: performance.now() - started,
      outcome,
    });
  }
}

/** Measures synchronous input capture separately from command execution and repository snapshots. */
export function measureSyncPhase<T>(store: Store, executionId: string, phase: ExecutionPhase, operation: () => T): T {
  const started = performance.now();
  let outcome = 'failed';
  try {
    const value = operation();
    outcome = 'completed';
    return value;
  } finally {
    store.appendExecution(executionId, 'execution.phase_measured', {
      phase,
      elapsedMs: performance.now() - started,
      outcome,
    });
  }
}
