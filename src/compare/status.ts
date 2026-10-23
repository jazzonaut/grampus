// A comparison's status for people and chat agents: its entries and whether it waits for a pick. Entries
// are listed by `grampus status` as ordinary tasks; this adds the comparison around them.
import { foldEvents } from '../pipeline/state.js';
import { summarise } from '../pipeline/status.js';
import { withObservedStop } from '../store/driver-lock.js';
import { TaskStore } from '../store/task-store.js';
import { ComparisonStore, foldComparison, type ComparisonMode, type ComparisonState } from './comparison.js';
import { crossCheckCounts } from './outcomes.js';
import { observedComparison } from './freshness.js';
import type { CheckAssertion } from '../checks/failure.js';

export interface ComparisonSummary {
  comparisonId: string;
  title: string;
  mode: ComparisonMode;
  entries: { taskId: string; recipe: string; phase: string }[];
  /** Recipes without an entry yet: waiting for a free place, or for the shared spec. */
  waiting: string[];
  /** While the cross-check runs: cells measured of all of them. */
  crossCheck: { done: number; total: number } | null;
  crossCheckOutcomes?: ReturnType<typeof crossCheckCounts>;
  assertions?: { owner: string; candidate: string; check: string; assertion: CheckAssertion }[];
  stale?: string | null;
  needsYou: { detail: string; since: string } | null;
  /** The latest refused pick or abandon, with why. */
  refused: { kind: string; reason: string; at: string } | null;
  finished: { outcome: string; winner: string | null; at: string } | null;
  lastStop: { reason: string; at: string } | null;
}

export function summariseComparison(dataDir: string, comparisonId: string): ComparisonSummary {
  const store = ComparisonStore.open(dataDir, comparisonId);
  const events = store.events();
  const state = observedComparison(dataDir, withObservedStop(foldComparison(events), store.dir, events));
  const entries = state.entries.map(entry => {
    let phase: string;
    try {
      phase = summarise(foldEvents(TaskStore.open(dataDir, entry.taskId).events())).phase;
    } catch (error) {
      phase = `unreadable: ${(error as Error).message}`;
    }
    return { taskId: entry.taskId, recipe: entry.recipe, phase };
  });
  return {
    comparisonId,
    title: state.title,
    mode: state.mode,
    entries,
    waiting: state.recipes.slice(state.entries.length).map(recipe => recipe.name),
    crossCheck: crossCheckProgress(state),
    stale: state.stale,
    crossCheckOutcomes: crossCheckCounts(state.crossCheck ?? state.crossCheckCells),
    assertions: (state.crossCheck ?? state.crossCheckCells).flatMap(cell =>
      (cell.assessments ?? []).flatMap(check =>
        (check.assertions ?? []).map(assertion => ({
          owner: cell.specOf,
          candidate: cell.candidate,
          check: check.name,
          assertion,
        })),
      ),
    ),
    needsYou: state.attention ? { detail: state.attention.detail, since: state.attention.since } : null,
    refused: state.refused,
    finished: state.finished,
    lastStop: state.finished ? null : state.lastStop,
  };
}

/** Cells measured of all of them while the cross-check runs; null before it starts and once it is in. */
export function crossCheckProgress(state: ComparisonState): { done: number; total: number } | null {
  if (state.crossCheck || state.crossCheckTotal === null || state.decision) return null;
  return { done: state.crossCheckCells.length, total: state.crossCheckTotal };
}

export function renderComparison(summary: ComparisonSummary): string {
  const lines = [`${summary.comparisonId}  ${summary.title}  (comparison, ${summary.mode} mode)`];
  if (summary.finished)
    lines.push(`  ${summary.finished.outcome}${summary.finished.winner ? `: kept ${summary.finished.winner}` : ''}`);
  if (summary.needsYou)
    lines.push(
      `  NEEDS YOU: ${summary.needsYou.detail}`,
      `    pick with \`grampus pick ${summary.comparisonId} <task>\` after comparing the entries`,
    );
  if (summary.stale) lines.push(`  STALE: ${summary.stale}`);
  if (summary.crossCheck)
    lines.push(
      `  cross-check running: ${summary.crossCheck.done} of ${summary.crossCheck.total} cells; the pick comes after it`,
    );
  const counts = summary.crossCheckOutcomes;
  if (counts?.total)
    lines.push(
      `  cross-check cells: ${counts.passed} passed, ${counts.failed} behavioural failures, ${counts.incompatible} incompatible, ${counts.errors} execution errors, ${counts.unknown} unknown (${counts.total} total)`,
    );
  if (summary.refused) lines.push(`  Refused ${summary.refused.kind}: ${summary.refused.reason}`);
  for (const item of summary.assertions ?? [])
    lines.push(
      `  assertion ${item.owner} -> ${item.candidate} / ${item.check}: ${item.assertion.test} [${item.assertion.outcome}]`,
      `    ${item.assertion.detail}`,
    );
  for (const entry of summary.entries) lines.push(`  ${entry.recipe}: ${entry.taskId}  ${entry.phase}`);
  if (summary.waiting.length) lines.push(`  not started yet: ${summary.waiting.join(', ')}`);
  if (summary.lastStop)
    lines.push(
      `  DRIVER STOPPED: ${summary.lastStop.reason}`,
      `    run \`grampus drive-comparison ${summary.comparisonId}\` in its Orca terminal to resume`,
    );
  return lines.join('\n');
}
