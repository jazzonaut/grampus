// Cross-check totals count whole spec/result pairs; unmeasured and incompatible cells never disappear.
import type { CrossCheckCell } from './comparison.js';

/** Categories are mutually exclusive, with execution and compatibility uncertainty taking precedence. */
export function crossCheckCounts(cells: readonly CrossCheckCell[]) {
  const counts = { passed: 0, total: cells.length, failed: 0, incompatible: 0, errors: 0, unknown: 0 };
  for (const cell of cells) {
    if (cell.error || !cell.results) {
      counts.errors++;
      continue;
    }
    if (cell.results.length && cell.results.every(result => result.passed)) {
      counts.passed++;
      continue;
    }
    const outcomes = cell.assessments?.map(item => item.outcome) ?? [];
    if (outcomes.includes('execution-error')) counts.errors++;
    else if (outcomes.includes('incompatible')) counts.incompatible++;
    else if (outcomes.includes('unknown') || !outcomes.length) counts.unknown++;
    else if (outcomes.includes('behavioural-failure')) counts.failed++;
    else counts.unknown++;
  }
  return counts;
}
