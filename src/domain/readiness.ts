// Owns the explicit mechanical check categories approved in a plan, never inferred from output.
import { z } from 'zod';
import { deepEqual } from './deep-equal.js';
import type { GuidedSlice } from './guided-plan.js';
import type { CheckSpec, RepositoryCheck } from '../persistence/records.js';

/** Read-only mechanical checks that precede behavioural validation on every implementation artifact. */
export const readinessKindSchema = z.enum(['format', 'lint', 'types']);
export type ReadinessKind = z.infer<typeof readinessKindSchema>;

/** The first approved mechanical check without a pass on the exact artifact and instructions. */
export function pendingReadiness(
  commands: GuidedSlice['readiness'],
  snapshot: { artifact: string; instructionsDigest: string },
  checks: readonly (Pick<RepositoryCheck, 'phase' | 'spec'> &
    Partial<Pick<RepositoryCheck, 'result' | 'error' | 'before' | 'after'>>)[],
  collectFailures = false,
): CheckSpec | null {
  for (const { kind, ...command } of commands) {
    const spec: CheckSpec = {
      ...command,
      readiness: kind,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
    };
    const latest = checks.findLast(check => deepEqual(check.spec, spec));
    const observedFailure =
      collectFailures &&
      latest?.phase === 'failed' &&
      latest.result?.reason === 'exited' &&
      latest.result.exitConfirmed &&
      !latest.error &&
      latest.before?.artifact === snapshot.artifact &&
      latest.after?.artifact === snapshot.artifact;
    if (latest?.phase !== 'passed' && !observedFailure) return spec;
  }
  return null;
}
