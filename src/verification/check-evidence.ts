// Owns the selection and compact summary of retained check results shown to agents as feedback. It
// only reads the journal; it never decides whether evidence passes a gate.
import type { Store } from '../persistence/store.js';
import type { Execution } from '../execution/execution-state.js';
import type { RepositoryCheck } from './checks.js';
import { checkFeedback } from './check-output.js';

/**
 * Settled checks from every execution of the same task and plan version as `execution`. Checks that are
 * still running or need recovery are left out because their outcome is not known yet.
 */
export function taskCheckEvidence(store: Store, execution: Execution): RepositoryCheck[] {
  return store
    .executions()
    .filter(item => item.taskId === execution.taskId && item.version === execution.version)
    .flatMap(item => store.checks(item.id))
    .filter(check => !['running', 'recovery_required'].includes(check.phase));
}

/**
 * JSON summary of the last five checks for a prompt. Output previews and the command line are dropped to
 * keep the prompt small; agents read full output through `grampus_read_check`.
 */
export function checkEvidenceSummary(checks: RepositoryCheck[]): string {
  return JSON.stringify(
    checks.slice(-5).map(check => {
      const { stdout: _stdout, stderr: _stderr, command: _command, ...summary } = checkFeedback(check);
      return summary;
    }),
  );
}
