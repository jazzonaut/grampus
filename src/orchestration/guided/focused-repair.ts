// Owns keeping supported browser repair failures inside the focused loop before broad gates.
import type { ImplementationRun } from '../../execution/implementations.js';
import { latestRepairProbe } from '../../execution/repair-probes.js';
import { checkFeedback } from '../../verification/check-output.js';
import { repairDiagnostic } from '../../verification/failure-focus.js';
import { successfulCheck } from '../../verification/check-reuse.js';
import { currentSlice } from './specs.js';
import type { SettleContext, StageOutcome, StateUpdate } from './context.js';

/** A focused probe is a prerequisite to broader repair checks, never a substitute for acceptance. */
export function focusedRepairOutcome(
  context: SettleContext,
  run: ImplementationRun,
  update: StateUpdate,
): StageOutcome | null {
  const { state, store } = context;
  if (!state.failedCheckId || !run.after) return null;
  const focus = repairDiagnostic(store.check(state.failedCheckId), currentSlice(state).diagnostics);
  if (!focus) return null;
  const probe = latestRepairProbe(store, run.id, state.failedCheckId);
  if (
    successfulCheck(probe ?? undefined) &&
    probe?.after?.artifact === run.after.artifact &&
    probe.after.instructionsDigest === run.after.instructionsDigest
  )
    return null;
  store.append(context.id, state.version, 'guided.focused_repair_required', {
    implementationId: run.id,
    failedCheckId: state.failedCheckId,
    probeId: probe?.id ?? null,
  });
  return {
    kind: 'advance',
    next: 'scope',
    update: current => {
      update(current);
      current.feedback = JSON.stringify({
        focusedRepair: focus,
        check: probe ? checkFeedback(probe) : null,
        instruction:
          'The focused failed cases have not passed on the final edited artifact. Inspect the retained failure and run repair or finish before broader checks. Final acceptance coverage remains mandatory.',
      });
      current.note = 'Continue the focused repair before broader checks.';
    },
  };
}
