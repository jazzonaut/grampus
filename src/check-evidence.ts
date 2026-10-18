import type { Store } from './store.js';
import type { Execution } from './execution-state.js';
import type { RepositoryCheck } from './checks.js';
import { checkFeedback } from './check-output.js';

export function taskCheckEvidence(store: Store, execution: Execution): RepositoryCheck[] {
  return store.executions<Execution>().filter(item => item.taskId === execution.taskId && item.version === execution.version)
    .flatMap(item => store.checks<RepositoryCheck>(item.id)).filter(check => !['running', 'recovery_required'].includes(check.phase));
}

export function checkEvidenceSummary(checks: RepositoryCheck[]): string {
  return JSON.stringify(checks.slice(-5).map(check => {
    const { stdout, stderr, command, ...summary } = checkFeedback(check);
    return summary;
  }));
}
