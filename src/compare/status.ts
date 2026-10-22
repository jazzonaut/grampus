// A comparison's status for people and chat agents: its entries and whether it waits for a pick. Entries
// are listed by `grampus status` as ordinary tasks; this adds the comparison around them.
import { foldEvents } from '../pipeline/state.js';
import { summarise } from '../pipeline/status.js';
import { TaskStore } from '../store/task-store.js';
import { ComparisonStore, foldComparison, type ComparisonMode } from './comparison.js';

export interface ComparisonSummary {
  comparisonId: string;
  title: string;
  mode: ComparisonMode;
  entries: { taskId: string; recipe: string; phase: string }[];
  /** Recipes without an entry yet: waiting for a free place, or for the shared spec. */
  waiting: string[];
  needsYou: { detail: string; since: string } | null;
  finished: { outcome: string; winner: string | null; at: string } | null;
  lastStop: { reason: string; at: string } | null;
}

export function summariseComparison(dataDir: string, comparisonId: string): ComparisonSummary {
  const state = foldComparison(ComparisonStore.open(dataDir, comparisonId).events());
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
    needsYou: state.attention ? { detail: state.attention.detail, since: state.attention.since } : null,
    finished: state.finished,
    lastStop: state.finished ? null : state.lastStop,
  };
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
  for (const entry of summary.entries) lines.push(`  ${entry.recipe}: ${entry.taskId}  ${entry.phase}`);
  if (summary.waiting.length) lines.push(`  not started yet: ${summary.waiting.join(', ')}`);
  if (summary.lastStop)
    lines.push(
      `  DRIVER STOPPED: ${summary.lastStop.reason}`,
      `    run \`grampus drive-comparison ${summary.comparisonId}\` in its Orca terminal to resume`,
    );
  return lines.join('\n');
}
