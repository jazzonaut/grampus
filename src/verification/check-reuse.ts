// Owns the conservative adoption rule for completed implementation diagnostics. Acceptance never
// adopts diagnostics, and a later failed or uncertain matching run supersedes earlier success.
import type { RepositoryCheck } from '../persistence/records.js';
import { deepEqual } from '../domain/deep-equal.js';

function successful(check: RepositoryCheck): boolean {
  const result = check.result;
  return (
    check.phase === 'passed' &&
    !check.error &&
    result?.reason === 'exited' &&
    result.exitCode === 0 &&
    result.exitConfirmed &&
    !result.outputUnavailable &&
    !result.outputTruncated
  );
}

/** Finds the latest exact diagnostic and returns it only when every observation proves reusable success. */
export function reusableDiagnostic(
  checks: RepositoryCheck[],
  target: RepositoryCheck,
  fingerprint: string | null,
): RepositoryCheck | null {
  if (!fingerprint || target.implementationId || !target.spec.reuse || target.spec.criteria || target.spec.preparation)
    return null;
  const { readiness: _readiness, ...expected } = target.spec;
  const candidate = checks.findLast(
    check =>
      check.id !== target.id &&
      check.implementationId &&
      !check.spec.preparation &&
      !check.spec.criteria &&
      deepEqual(check.spec, expected),
  );
  if (
    !candidate ||
    !successful(candidate) ||
    candidate.inputFingerprint?.before !== fingerprint ||
    candidate.inputFingerprint.after !== fingerprint ||
    candidate.before?.artifact !== target.spec.artifact ||
    candidate.after?.artifact !== target.spec.artifact ||
    candidate.after.instructionsDigest !== target.spec.instructionsDigest
  )
    return null;
  return candidate;
}
