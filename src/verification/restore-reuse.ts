// Owns conservative restoration reuse across attempts in one task/version/workspace. Missing inputs
// or changed managed outputs force execution; agent claims never stand in for a restore receipt.
import type { Store } from '../persistence/store.js';
import type { Execution, RepositoryCheck } from '../persistence/records.js';
import { checkInputFingerprint } from './check-inputs.js';
import { deepEqual } from '../domain/deep-equal.js';

/** Captures the declared inputs and the post-restore managed tree under the workspace lease. */
export function restoreFingerprint(cwd: string, check: RepositoryCheck, side: 'before' | 'after'): void {
  const policy = check.spec.restore;
  if (!policy) return;
  check.restoreFingerprint ??= { before: null, after: null, outputs: null };
  check.restoreFingerprint[side] = checkInputFingerprint(cwd, check.spec.file, policy.inputs);
  if (side === 'after') check.restoreFingerprint.outputs = checkInputFingerprint(cwd, check.spec.file, policy.outputs);
}

/** Returns the latest matching successful restore only when all declared current bytes agree. */
export function reusableRestore(
  store: Store,
  execution: Execution,
  check: RepositoryCheck,
  cwd: string,
): RepositoryCheck | null {
  if (
    !check.spec.restore ||
    !check.spec.preparation ||
    check.spec.preparation.scope ||
    !check.restoreFingerprint?.before
  )
    return null;
  const { artifact: _artifact, ...expected } = check.spec;
  const candidates = store
    .executions(execution.taskId)
    .filter(item => item.workspaceId === execution.workspaceId && item.version === execution.version)
    .flatMap(item => store.checks(item.id));
  const source = candidates.findLast(item => {
    const { artifact: _previous, ...spec } = item.spec;
    return item.id !== check.id && deepEqual(spec, expected);
  });
  if (
    !source ||
    source.phase !== 'passed' ||
    source.error ||
    !source.result?.exitConfirmed ||
    source.result.exitCode !== 0 ||
    source.result.reason !== 'exited' ||
    source.result.outputUnavailable ||
    source.result.outputTruncated
  )
    return null;
  const fingerprint = check.restoreFingerprint.before;
  const outputs = checkInputFingerprint(cwd, check.spec.file, check.spec.restore.outputs);
  return outputs &&
    source.restoreFingerprint?.before === fingerprint &&
    source.restoreFingerprint.after === fingerprint &&
    source.restoreFingerprint.outputs === outputs
    ? source
    : null;
}
