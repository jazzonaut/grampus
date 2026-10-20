// Owns the eligibility rule for rerunning a stopped check without a new implementation attempt: which
// infrastructure stops qualify, and what the retained check record must prove before the same check
// spec may run again on the same artifact. It only decides; claiming the runner, re-snapshotting the
// workspace and running the check stay in the controller.
import type { Task } from '../../domain/workflow.js';
import { activeCriteria } from '../../domain/workflow.js';
import { deepEqual } from '../../domain/deep-equal.js';
import type { Store } from '../../persistence/store.js';
import type { StopReasonCode } from './stop-reasons.js';
import type { GuidedState } from './state.js';
import { dueAcceptance, validationSpec } from './specs.js';

/**
 * Stops caused by the check's environment rather than by the implementation: the command timed out,
 * was interrupted, lost its output, did not exit normally, or the runner recorded an error. Each says
 * nothing about the artifact, so running the same check again is a fair test of it.
 *
 * Deliberately excluded: `CHECK_OUTPUT_LIMIT` and `CHECK_OUTPUT_TRUNCATED` (the same command on the
 * same bytes produces the same output again, so revise the check instead), `CHECK_MUTATED_ARTIFACT`
 * and `CHECK_STALE_ARTIFACT` (the artifact is no longer the one checked), and every stop whose check
 * still needs recovery, which never reaches a settled stop at all.
 */
export const rerunnableStops: ReadonlySet<StopReasonCode> = new Set<StopReasonCode>([
  'CHECK_TIMEOUT',
  'CHECK_INTERRUPTED',
  'CHECK_EXIT_UNCONFIRMED',
  'CHECK_OUTPUT_UNAVAILABLE',
  'CHECK_ERROR',
]);

/** Why the retained check record cannot support a rerun of the current step, or null when it can. */
function checkIneligibility(store: Store, task: Task, state: GuidedState): string | null {
  if (!state.failedCheckId || !state.executionId || !state.snapshot) return 'No retained failed check to rerun';
  const check = store.check(state.failedCheckId);
  if (
    check.executionId !== state.executionId ||
    check.purpose !== state.stage ||
    !['failed', 'interrupted'].includes(check.phase)
  )
    return 'The retained check does not belong to the current stopped step';
  // A dispatched check without a confirmed exit may still have live descendants writing to the
  // workspace; PID absence alone never proves settlement, so this needs recovery, not a second run.
  if (check.dispatch !== 'not_requested' && check.result?.exitConfirmed !== true)
    return 'The check process tree was not confirmed settled; recover it instead of rerunning';
  // Acceptance resumes at the first check not yet passed on this artifact, which is the stopped one.
  const expected =
    state.stage === 'validation'
      ? validationSpec(state)
      : dueAcceptance(state, activeCriteria(task), store.checks(state.executionId))?.spec;
  if (!expected || !deepEqual(check.spec, expected))
    return 'The retained check differs from the approved check for this step';
  // A check without a before-snapshot never observed the workspace; the controller's fresh snapshot at
  // rerun still compares it with the held artifact.
  if (check.before && check.before.artifact !== state.snapshot.artifact)
    return 'The check ran on a different artifact; start a new attempt with task-retry';
  return null;
}

/**
 * Why the task's stopped check may not be rerun, or null when it may. Beyond an eligible stop code
 * the retained record must show a settled process tree (never dispatched, or a confirmed exit), the
 * exact approved spec for this stage, and the artifact the controller still holds. The workspace
 * itself is compared again when the rerun starts.
 */
export function rerunChecksIneligibility(store: Store, task: Task): string | null {
  const state = task.guided;
  if (!state) return 'This task has no guided plan';
  // Runner ownership is the controller's to check: it claims the runner before rerunning.
  if (state.pending) return 'Recover the unfinished operation before rerunning checks';
  if (state.status !== 'blocked' || (state.stage !== 'validation' && state.stage !== 'verification'))
    return 'Rerun checks applies only to a stopped validation or acceptance check';
  const code = state.stopReason?.code;
  if (!code || !rerunnableStops.has(code))
    return `Rerun checks applies after ${[...rerunnableStops].join(', ')}; this stop (${code ?? 'none'}) needs a retry, a revised plan or recovery`;
  return checkIneligibility(store, task, state);
}
