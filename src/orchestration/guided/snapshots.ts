// Owns how the guided state refers to repository snapshots. A full snapshot (file inventory with
// hashes, retained diff contents, Git index and instructions) is written once to the content-addressed
// `snapshots` table; the guided state keeps only its digests and a small summary, so saving the state
// on every change no longer re-serialises the snapshot. Evidence binding compares the same digests.
import type { Store } from '../../persistence/store.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { GuidedState } from './state.js';

/** The guided state's reference to the current snapshot: the digests it binds, and a summary for views. */
export interface SnapshotRef {
  /** The artifact digest: the key of the stored snapshot and what every piece of evidence names. */
  artifact: string;
  head: string;
  instructionsDigest: string;
  totalFiles: number;
  /** Paths that differ from the pinned base. */
  changedPaths: string[];
}

/** Stores `snapshot` (once per artifact) and returns the reference the guided state keeps. */
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

/** The full snapshot the guided state refers to, or null when it refers to none. */
export function guidedSnapshot(store: Store, state: Pick<GuidedState, 'snapshot'>): RepositorySnapshot | null {
  if (!state.snapshot) return null;
  const snapshot = store.snapshot(state.snapshot.artifact);
  if (!snapshot) throw new Error(`The retained snapshot ${state.snapshot.artifact} is missing from the journal`);
  return snapshot;
}

/** The full current snapshot; for steps that cannot run without one. */
export function requireGuidedSnapshot(store: Store, state: Pick<GuidedState, 'snapshot'>): RepositorySnapshot {
  const snapshot = guidedSnapshot(store, state);
  if (!snapshot) throw new Error('This step requires a current repository snapshot');
  return snapshot;
}
