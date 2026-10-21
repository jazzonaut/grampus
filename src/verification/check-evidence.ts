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
    .executions(execution.taskId)
    .filter(item => item.version === execution.version)
    .flatMap(item => store.checks(item.id))
    .filter(check => !['running', 'recovery_required'].includes(check.phase));
}

/**
 * Every retained check bound to the reviewed artifact, never results for other bytes. Without the
 * `grampus_read_check` tool the bounded output excerpts stay in, because they are all the reviewer sees.
 */
export function reviewCheckEvidence(checks: RepositoryCheck[], artifact: string | null, readable: boolean): string {
  return JSON.stringify(
    checks
      .filter(check => check.spec.artifact === artifact)
      .map(check => {
        const { stdout, stderr, command: _command, readMore, ...summary } = checkFeedback(check);
        return readable ? { ...summary, readMore } : { ...summary, stdout, stderr };
      }),
  );
}
