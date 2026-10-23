// Dashboard views of comparisons: the list, one comparison with its entries and cross-check, and the
// measured figures behind the side-by-side table. Metrics measure running entries from their transcripts,
// so they are a separate, slower request than the detail.
import { basename } from 'node:path';
import {
  ComparisonStore,
  foldComparison,
  listComparisonIds,
  type ComparisonState,
  type StoredComparisonEvent,
} from '../compare/comparison.js';
import { entryDone, entryPickable } from '../compare/driver.js';
import { crossCheckProgress } from '../compare/status.js';
import { buildScorecard } from '../measure/report.js';
import { measureDispatches } from '../measure/usage.js';
import type { TaskState } from '../pipeline/state.js';
import { finalCandidate } from '../pipeline/candidate.js';
import { crossCheckCounts } from '../compare/outcomes.js';
import { observedComparison } from '../compare/freshness.js';
import { withObservedStop } from '../store/driver-lock.js';
import type { DashboardOrca } from './api.js';
import type { TaskReader } from './tasks.js';
import type {
  ComparisonDetail,
  ComparisonListItem,
  ComparisonMetrics,
  ComparisonStatus,
  EntryMetrics,
} from './types.js';
import { listItem } from './views.js';

interface Loaded {
  state: ComparisonState;
  events: StoredComparisonEvent[];
}

/** A comparison as the dashboard shows it: a driver that went missing without recording why is stopped. */
export function loadComparison(dataDir: string, comparisonId: string): Loaded {
  const store = ComparisonStore.open(dataDir, comparisonId);
  const events = store.events();
  return { state: observedComparison(dataDir, withObservedStop(foldComparison(events), store.dir, events)), events };
}

/** Every readable comparison, newest activity first. */
export function comparisonList(dataDir: string): ComparisonListItem[] {
  return listComparisonIds(dataDir)
    .flatMap(id => {
      try {
        const { state, events } = loadComparison(dataDir, id);
        return [summaryOf(state, events)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function statusOf(state: ComparisonState): ComparisonStatus {
  if (state.finished) return state.finished.outcome;
  if (state.attention) return 'needs-you';
  if (state.lastStop) return 'stopped';
  return 'running';
}

function summaryOf(state: ComparisonState, events: readonly StoredComparisonEvent[]): ComparisonListItem {
  return {
    comparisonId: state.comparisonId,
    title: state.title,
    mode: state.mode,
    recipes: state.recipes.map(recipe => recipe.name),
    status: statusOf(state),
    entries: state.entries.length,
    createdAt: state.createdAt,
    updatedAt: events.at(-1)?.at ?? state.createdAt,
    winner: state.finished?.winner ?? null,
  };
}

function entries(
  reader: TaskReader,
  state: ComparisonState,
): { recipe: string; task: TaskState; events: ReturnType<TaskReader['load']>['events'] }[] {
  return state.entries.map(entry => {
    const loaded = reader.load(entry.taskId);
    return { recipe: entry.recipe, task: loaded.state, events: loaded.events };
  });
}

export function comparisonDetail(dataDir: string, reader: TaskReader, comparisonId: string): ComparisonDetail {
  const { state, events } = loadComparison(dataDir, comparisonId);
  return {
    ...summaryOf(state, events),
    request: state.request,
    repository: { path: state.repoPath, name: basename(state.repoPath) },
    baseSha: state.baseSha,
    concurrency: state.concurrency,
    waiting: state.recipes.slice(state.entries.length).map(recipe => recipe.name),
    sharedSpec: state.sharedSpec,
    needsYou: state.attention ? { detail: state.attention.detail, since: state.attention.since } : null,
    stale: state.stale,
    lastStop: state.finished ? null : state.lastStop,
    entryViews: entries(reader, state).map(({ recipe, task, events: taskEvents }) => {
      const checks = finalCandidate(task);
      const review = checks?.review;
      return {
        task: listItem(task, taskEvents),
        recipe,
        done: entryDone(task),
        // Only once the comparison asks: the driver refuses a pick sent before then.
        pickable: !state.decision && state.attention?.reason === 'pick' && entryPickable(task),
        checks: checks
          ? { passed: checks.results.filter(result => result.passed).length, total: checks.results.length }
          : null,
        review: review ? (review.report?.verdict ?? 'unavailable') : null,
        rounds: task.decisions.size,
      };
    }),
    crossCheck: state.crossCheck ?? (state.crossCheckCells.length ? state.crossCheckCells : null),
    crossCheckProgress: crossCheckProgress(state),
    refused: state.refused,
  };
}

/** The time from an entry's creation to the result the user decides on, or null while it still works. */
function resultMs(task: TaskState): number | null {
  const end = task.finished?.at ?? (entryDone(task) ? task.attention?.since : undefined);
  return end ? Date.parse(end) - Date.parse(task.createdAt) : null;
}

export async function comparisonMetrics(
  dataDir: string,
  reader: TaskReader,
  orca: DashboardOrca,
  comparisonId: string,
): Promise<ComparisonMetrics> {
  const { state } = loadComparison(dataDir, comparisonId);
  const measured: EntryMetrics[] = [];
  for (const { recipe, task, events } of entries(reader, state)) {
    const card = buildScorecard(task, events, task.measurements ?? (await measureDispatches(task, orca)));
    const cells = (state.crossCheck ?? []).filter(
      cell => cell.candidate === task.taskId && cell.specOf !== task.taskId,
    );
    const counts = crossCheckCounts(cells);
    measured.push({
      taskId: task.taskId,
      recipe,
      resultMs: resultMs(task),
      agentMs: card.totals.agentMs,
      usage: card.totals.usage,
      costUsd: card.totals.costUsd,
      dispatchesWithUnknownCost: card.totals.dispatchesWithUnknownCost,
      decisions: card.human.decisions,
      answers: card.human.answers,
      waitingMs: card.human.waitingMs,
      crossCheck: cells.length ? counts : null,
      provisional: !card.final,
    });
  }
  return { asOf: new Date().toISOString(), entries: measured };
}
