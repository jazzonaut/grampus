// Owns how the guided state refers to repository snapshots. A full snapshot (file inventory with hashes,
// retained diff contents, Git index and instructions) is written once to the content-addressed `snapshots`
// table; the guided state keeps only its digests and a small summary, so a state change never re-serialises
// it. Evidence binding compares the same digests. A stored snapshot is never rewritten.
import { z } from 'zod';
import type { Store } from '../../persistence/store.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { GuidedState } from './state.js';

/** The guided state's reference to the current snapshot: the digests it binds, and a summary for views. */
export const snapshotRefSchema = z.object({
  /** The artifact digest: the key of the stored snapshot and what every piece of evidence names. */
  artifact: z.string(),
  head: z.string(),
  instructionsDigest: z.string(),
  totalFiles: z.number(),
  /** Paths that differ from the pinned base. */
  changedPaths: z.array(z.string()),
});
export type SnapshotRef = z.infer<typeof snapshotRefSchema>;

/**
 * Stores `snapshot` (once per artifact) and returns the reference the guided state keeps. A second
 * save of the same artifact keeps the first row, which is safe because the artifact digest covers
 * every byte the snapshot binds. Call it inside the state change that adopts the reference, so the
 * row and the reference to it are committed together.
 */
export function keepSnapshot(store: Store, snapshot: RepositorySnapshot): SnapshotRef {
  store.saveSnapshot(snapshot);
  return {
    artifact: snapshot.artifact,
    head: snapshot.head,
    instructionsDigest: snapshot.instructionsDigest,
    totalFiles: snapshot.files.length,
    changedPaths: snapshot.diff.map(change => change.path),
  };
}

/**
 * The full snapshot the guided state refers to, or null when it refers to none. Throws when the state
 * names an artifact the journal does not hold, since evidence bound to it could no longer be checked.
 */
export function guidedSnapshot(store: Store, state: Pick<GuidedState, 'snapshot'>): RepositorySnapshot | null {
  if (!state.snapshot) return null;
  const snapshot = store.snapshot(state.snapshot.artifact);
  if (!snapshot) throw new Error(`The retained snapshot ${state.snapshot.artifact} is missing from the journal`);
  return snapshot;
}

/** The full current snapshot, for steps that cannot run without one; throws when there is none. */
export function requireGuidedSnapshot(store: Store, state: Pick<GuidedState, 'snapshot'>): RepositorySnapshot {
  const snapshot = guidedSnapshot(store, state);
  if (!snapshot) throw new Error('This step requires a current repository snapshot');
  return snapshot;
}
