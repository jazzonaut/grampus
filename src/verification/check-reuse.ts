// Owns the conservative adoption rule for completed implementation diagnostics. Acceptance never
// adopts diagnostics, and a later failed or uncertain matching run supersedes earlier success.
import type { CheckSpec, RepositoryCheck } from '../persistence/records.js';
import { deepEqual } from '../domain/deep-equal.js';

/** A reusable result needs a fully observed, confirmed successful process, never only a phase label. */
export function successfulCheck(
  check: RepositoryCheck | undefined,
): check is RepositoryCheck & { result: NonNullable<RepositoryCheck['result']> } {
  const result = check?.result;
  return (
    check?.phase === 'passed' &&
    !check.error &&
    result?.reason === 'exited' &&
    result.exitCode === 0 &&
    result.exitConfirmed &&
    !result.outputUnavailable &&
    !result.outputTruncated
  );
}

/** An explicitly repeatable diagnostic can return its existing receipt during this same editing run. */
export function reusableImplementationDiagnostic(
  checks: RepositoryCheck[],
  implementationId: string,
  spec: CheckSpec,
  fingerprint: string | null,
): RepositoryCheck | null {
  if (!spec.reuse || spec.preparation || spec.criteria || !fingerprint) return null;
  const source = checks.findLast(check => check.implementationId === implementationId && deepEqual(check.spec, spec));
  return successfulCheck(source) &&
    source.before?.artifact === spec.artifact &&
    source.after?.artifact === spec.artifact &&
    source.inputFingerprint?.before === fingerprint &&
    source.inputFingerprint.after === fingerprint
    ? source
    : null;
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
    !successfulCheck(candidate) ||
    candidate.inputFingerprint?.before !== fingerprint ||
    candidate.inputFingerprint.after !== fingerprint ||
    candidate.before?.artifact !== target.spec.artifact ||
    candidate.after?.artifact !== target.spec.artifact ||
    candidate.after.instructionsDigest !== target.spec.instructionsDigest
  )
    return null;
  return candidate;
}
