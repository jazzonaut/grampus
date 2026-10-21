// Owns explicit supplemental diagnostic permissions, bound to one approved task version and slice.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import { commandLimits } from '../config/limits.js';

const allowanceSchema = z.object({
  family: z.string(),
  from: z.number().int().positive(),
  to: z.number().int().positive().max(commandLimits.diagnosticRuns),
  digest: z.string(),
  sliceIndex: z.number().int(),
  version: z.number().int(),
  implementationId: z.string(),
});
const approvedSchema = allowanceSchema.extend({ requestId: z.string() });

/** Resolves only supplements explicitly approved for the current immutable plan. */
export function diagnosticLimit(store: Store, executionId: string, family: string, base: number): number {
  const execution = store.execution(executionId),
    state = store.get(execution.taskId).guided;
  if (!state) return base;
  return store.events(execution.taskId, ['guided.diagnostic_allowance_approved']).reduce((limit, event) => {
    const grant = approvedSchema.safeParse(event.data).data;
    return grant &&
      grant.version === execution.version &&
      grant.sliceIndex === execution.sliceIndex &&
      grant.digest === state.approvedDigest &&
      grant.family === family
      ? Math.max(limit, grant.to)
      : limit;
  }, base);
}

/** A durable proposal, never a permission; answering agent prose cannot approve it. */
export function requestDiagnosticAllowance(
  store: Store,
  implementationId: string,
  family: string,
  limit: number,
): void {
  const run = store.implementation(implementationId),
    execution = store.execution(run.executionId);
  if (
    run.phase !== 'running' ||
    store.session(execution.sessionId).run?.id !== run.id ||
    store.lease(execution.workspaceId)?.runId !== run.id
  )
    throw new Error('Diagnostic allowance request requires the active implementation lease');
  const state = store.get(execution.taskId).guided;
  if (!state) return;
  const existing = store.executionEvents(execution.id, ['implementation.diagnostic_allowance_requested']);
  if (
    existing.some(event => {
      const data = allowanceSchema.safeParse(event.data).data;
      return data?.implementationId === run.id && data.family === family && data.from === limit;
    })
  )
    return;
  store.appendExecution(execution.id, 'implementation.diagnostic_allowance_requested', {
    family,
    from: limit,
    to: Math.min(commandLimits.diagnosticRuns, limit + commandLimits.diagnosticSupplementRuns),
    digest: state.digest,
    sliceIndex: execution.sliceIndex,
    version: execution.version,
    implementationId,
  });
}

/** Finds an unapproved proposal from the current settled implementation only. */
export function pendingDiagnosticAllowance(store: Store, executionId: string, implementationId?: string) {
  const execution = store.execution(executionId),
    state = store.get(execution.taskId).guided;
  if (!state || state.approvedDigest !== state.digest) return null;
  const runId = implementationId ?? store.implementations(executionId).at(-1)?.id;
  const approvals = store.events(execution.taskId, ['guided.diagnostic_allowance_approved']);
  for (const event of store.executionEvents(executionId, ['implementation.diagnostic_allowance_requested'])) {
    const data = allowanceSchema.safeParse(event.data).data;
    const requestId = `${executionId}:${event.sequence}`;
    if (
      !data ||
      data.implementationId !== runId ||
      data.version !== state.version ||
      data.digest !== state.digest ||
      data.sliceIndex !== state.sliceIndex ||
      approvals.some(approval => approvedSchema.safeParse(approval.data).data?.requestId === requestId)
    )
      continue;
    return { ...data, requestId };
  }
  return null;
}
