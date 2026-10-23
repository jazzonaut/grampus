// Bind comparison cells and decisions to both entries, and hide stale evidence even between driver passes.
import { finalCandidate } from '../pipeline/candidate.js';
import { foldEvents, type TaskState } from '../pipeline/state.js';
import { TaskStore } from '../store/task-store.js';
import type { ComparisonState, CrossCheckCell, EntryEvidence } from './comparison.js';

/** Pending entry mutations close the pick window before the entry driver applies them. */
export function comparisonEntry(dataDir: string, taskId: string): TaskState {
  const store = TaskStore.open(dataDir, taskId);
  const state = foldEvents(store.events());
  const pending = store
    .commands()
    .some(
      command => !state.applied.has(command.id) && ['continue', 'revise', 'retry', 'abandon'].includes(command.kind),
    );
  return pending && !state.finished ? { ...state, attention: null } : state;
}

/** Unreadable entries cannot authorise a pick or contribute current evidence. */
export function observedComparison(dataDir: string, state: ComparisonState): ComparisonState {
  const entries = state.entries.flatMap(entry => {
    try {
      return [comparisonEntry(dataDir, entry.taskId)];
    } catch {
      return [];
    }
  });
  return currentComparison(state, entries);
}

/** Whether an entry has reached a result the user can decide on. */
export function entryDone(state: TaskState): boolean {
  return state.finished !== null || /^(ready|escalate):/.test(state.attention?.reason ?? '');
}

/** Whether the entry itself currently accepts a decision. Comparison freshness is checked separately. */
export function entryPickable(state: TaskState): boolean {
  return state.finished === null && (state.attention?.options.includes('accept') ?? false);
}

/** Bind to the test-source commit as well as the approved spec; continuing invalidates even an unchanged SHA. */
export function entryEvidence(state: TaskState): EntryEvidence {
  const candidate = finalCandidate(state);
  const spec = state.specs.at(-1);
  return {
    taskId: state.taskId,
    sha: candidate?.sha ?? null,
    round: candidate?.round ?? null,
    specVersion: spec?.version ?? null,
    specHash: spec?.hash ?? null,
    revision:
      state.commands.findLast(command => ['continue', 'revise', 'retry', 'abandon'].includes(command.kind))?.id ?? null,
  };
}

/** A copied test result is reusable only for the exact source and target evidence. */
export function cellIsCurrent(cell: CrossCheckCell, entries: readonly TaskState[]): boolean {
  const owner = entries.find(entry => entry.taskId === cell.specOf);
  const candidate = entries.find(entry => entry.taskId === cell.candidate);
  return (
    !!owner &&
    !!candidate &&
    entryDone(owner) &&
    entryDone(candidate) &&
    JSON.stringify(cell.binding) ===
      JSON.stringify({ owner: entryEvidence(owner), candidate: entryEvidence(candidate) })
  );
}

/** Read-only projection used by the driver, CLI and dashboard so an old pick is never presented as current. */
export function currentComparison(state: ComparisonState, entries: readonly TaskState[]): ComparisonState {
  if (state.decision || state.finished) return state;
  const cells = state.crossCheckCells.filter(cell => cellIsCurrent(cell, entries));
  const complete = entries.length === state.recipes.length && entries.every(entryDone);
  const attentionCurrent =
    !state.attention ||
    (complete && JSON.stringify(state.attention.evidence) === JSON.stringify(entries.map(entryEvidence)));
  const changed = cells.length !== state.crossCheckCells.length || !attentionCurrent;
  if (!changed) return state;
  return {
    ...state,
    crossCheckCells: cells,
    crossCheck: null,
    attention: null,
    stale:
      'An entry changed. Previous comparison evidence is stale; picking is disabled until the results and cross-checks are refreshed.',
  };
}
