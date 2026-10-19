// Owns the exact leaf requests a guided step dispatches: edit policy, preparation, check and
// delivery specs, and the reviewer. Each step builds its request here before dispatch and builds it
// again at settlement, so a result is adopted only if it answers exactly the approved request.
import { commandLimits } from '../../config/limits.js';
import type { GuidedPlan, GuidedSlice } from '../../domain/guided-plan.js';
import { selectedEditPasses, type QualityPassDefinition } from '../../domain/quality-passes.js';
import type { EditPolicy } from '../../execution/edit-policy.js';
import type { DeliverySpec } from '../../execution/deliveries.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { CheckSpec } from '../../verification/checks.js';
import type { GuidedState, Stage } from './state.js';

/** Automatic mode authorizes scope at approval and repairs ordinary failures without a click. */
export function automatic(state: GuidedState): boolean {
  return state.plan.workflowPolicy.mode === 'automatic';
}

/** The slice the task is currently delivering. */
export function currentSlice(state: GuidedState): GuidedSlice {
  return state.plan.slices[state.sliceIndex]!;
}

/** The snapshot every check, review and delivery of the current attempt is bound to. */
function requireSnapshot(state: GuidedState): RepositorySnapshot {
  return state.snapshot!;
}

/**
 * The exact edit policy for the current slice on `snapshot`. Planned creations that already exist
 * (from an earlier interrupted attempt) become edits, and planned deletions already done drop out.
 * Returns null when a deletion-only slice has nothing left to delete, so no editing turn is needed.
 */
export function editPolicy(state: GuidedState, snapshot: RepositorySnapshot): EditPolicy | null {
  const scope = currentSlice(state).scope;
  const present = (path: string) => snapshot.files.some(file => file.path === path && file.sha256 !== null);
  const created = (scope.create ?? []).filter(present);
  if (!scope.files.length && !scope.create?.length && scope.delete?.length && !scope.delete.some(present)) return null;
  return {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    files: [...scope.files, ...created],
    ...((scope.create ?? []).some(path => !present(path))
      ? { create: scope.create!.filter(path => !present(path)) }
      : {}),
    ...((scope.delete ?? []).some(present) ? { delete: scope.delete!.filter(present) } : {}),
  };
}

/**
 * The preparation request for the `preparation` or `refresh` stage. Initial preparation may not
 * change repository inputs at all; a slice's own refresh may change only that slice's authorized
 * files, which is why its edit policy becomes the preparation scope.
 */
export function preparationSpec(state: GuidedState): CheckSpec {
  const slice = currentSlice(state);
  const command =
    state.stage === 'preparation' ? state.plan.preparation : (slice.preparation ?? state.plan.preparation);
  if (!command || !state.snapshot) throw new Error('Preparation requires an approved command and current snapshot');
  const policy =
    state.stage === 'refresh' && slice.preparation && slice.mode !== 'no_change'
      ? editPolicy(state, state.snapshot)
      : null;
  const scope =
    policy && (policy.files.length || policy.create?.length || policy.delete?.length)
      ? {
          files: policy.files,
          ...(policy.create ? { create: policy.create } : {}),
          ...(policy.delete ? { delete: policy.delete } : {}),
        }
      : undefined;
  return {
    ...command,
    artifact: state.snapshot.artifact,
    instructionsDigest: state.snapshot.instructionsDigest,
    preparation: scope ? { scope } : {},
  };
}

/** The validation request, bound to the current artifact. */
export function validationSpec(state: GuidedState): CheckSpec {
  const snapshot = requireSnapshot(state);
  return {
    ...currentSlice(state).validation,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
  };
}

/** The acceptance request, bound to the current artifact and the task's active criteria. */
export function acceptanceSpec(state: GuidedState, criteria: string[]): CheckSpec {
  const snapshot = requireSnapshot(state);
  return {
    ...currentSlice(state).acceptance,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    criteria,
  };
}

/** The local delivery request for the checked artifact. */
export function deliverySpec(state: GuidedState): DeliverySpec {
  const snapshot = requireSnapshot(state),
    slice = currentSlice(state);
  return {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    message: slice.message,
    mode: slice.mode,
    timeoutMs: commandLimits.deliveryTimeoutMs,
  };
}

/** After editing, refresh prerequisites when any preparation is approved; otherwise validate directly. */
export function afterImplementation(state: GuidedState): Stage {
  return currentSlice(state).preparation || state.plan.preparation ? 'refresh' : 'validation';
}

/** The next selected edit pass that has not yet run in this slice, or null. */
export function pendingEditPass(state: GuidedState): QualityPassDefinition | null {
  return (
    selectedEditPasses(state.plan.quality).find(pass => !state.qualityEdits.some(done => done.pass === pass.id)) ?? null
  );
}

/**
 * After an implementation or edit pass turn left `snapshot`: the next edit pass while one remains and
 * there is still something editable, otherwise the post-implementation steps.
 */
export function afterEditing(state: GuidedState, snapshot: RepositorySnapshot): Stage {
  return pendingEditPass(state) && editPolicy(state, snapshot) ? 'quality_pass' : afterImplementation(state);
}

/** The fresh arbitrator while arbitrating, otherwise the independent reviewer. */
export function reviewer(state: GuidedState): GuidedPlan['review'] {
  return state.reviewCycle.arbitrating ? state.plan.reviewPolicy!.arbitrator! : state.plan.review;
}
