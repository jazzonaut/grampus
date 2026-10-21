// Owns stable captures for read-only diagnostic waves. A shared after-image requires every process to settle.
import type { RepositorySnapshot } from '../repository/artifacts.js';
import type { RepositoryCheck } from '../persistence/records.js';

/** Captured input is local to one leased operation; it is never reused across turns or recovery. */
export interface CheckObservationGroup {
  before: RepositorySnapshot;
  settled: (check: RepositoryCheck) => void;
  after: () => Promise<RepositorySnapshot>;
}

/** Shares a stable after-image only after every child has exited or is proven undispatched. */
export async function diagnosticObservationGroup(
  capture: () => Promise<RepositorySnapshot>,
  batch: RepositoryCheck[],
  captured?: RepositorySnapshot,
): Promise<CheckObservationGroup> {
  const before = captured ?? (await capture());
  const settled = new Set<string>();
  let ready = () => {};
  const completed = new Promise<void>(resolve => {
    ready = resolve;
  });
  let after: Promise<RepositorySnapshot> | undefined;
  return {
    before,
    settled: check => {
      settled.add(check.id);
      if (settled.size === batch.length) ready();
    },
    after: () =>
      (after ??= completed.then(() => {
        if (batch.some(check => check.dispatch === 'requested' && !check.result?.exitConfirmed))
          throw new Error('Read-only diagnostic group has an uncertain child; artifact evidence unavailable');
        return capture();
      })),
  };
}

/** Standalone commands take fresh observations; a leased group supplies its coordinated captures. */
export function checkObservationCaptures(
  capture: () => Promise<RepositorySnapshot>,
  group?: CheckObservationGroup,
): Omit<CheckObservationGroup, 'before'> & { before: () => Promise<RepositorySnapshot> } {
  if (group) return { before: () => Promise.resolve(group.before), after: group.after, settled: group.settled };
  return { before: capture, after: capture, settled: () => {} };
}
