// Owns the exact leaf requests a guided step dispatches: edit policy, preparation, check and
// delivery specs, and the reviewer. Each step builds its request here before dispatch and builds it
// again at settlement, so a result is adopted only if it answers exactly the approved request. These
// are pure functions of the state, snapshot and any check records passed in; nothing here dispatches
// work or writes the journal.
import { commandLimits } from '../../config/limits.js';
import type { GuidedPlan, GuidedSlice } from '../../domain/guided-plan.js';
import { selectedEditPasses, type QualityPassDefinition } from '../../domain/quality-passes.js';
import type { EditPolicy } from '../../execution/edit-policy.js';
import type { DeliverySpec } from '../../execution/deliveries.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { CheckSpec, RepositoryCheck } from '../../verification/checks.js';
import { deepEqual } from '../../domain/deep-equal.js';
import { required, type GuidedState, type Stage } from './state.js';

/** Automatic mode authorizes scope at approval and repairs ordinary failures without a click. */
export function automatic(state: GuidedState): boolean {
  return state.plan.workflowPolicy.mode === 'automatic';
}

/** The slice the task is currently delivering; throws when the slice index is past the plan. */
export function currentSlice(state: GuidedState): GuidedSlice {
  const slice = state.plan.slices[state.sliceIndex];
  if (!slice) throw new Error(`The guided plan has no slice ${state.sliceIndex + 1}`);
  return slice;
}

/**
 * The exact edit policy for the current slice on `snapshot`. Planned creations that already exist
 * (from an earlier interrupted attempt) become edits, and planned deletions already done drop out.
 * Returns null when a deletion-only slice has nothing left to delete, so no editing turn is needed.
 */
export function editPolicy(state: GuidedState, snapshot: RepositorySnapshot): EditPolicy | null {
  const scope = currentSlice(state).scope;
  const present = (path: string) => snapshot.files.some(file => file.path === path && file.sha256 !== null);
  const creations = scope.create ?? [],
    deletions = scope.delete ?? [];
  if (!scope.files.length && !creations.length && deletions.length && !deletions.some(present)) return null;
  const created = creations.filter(present),
    toCreate = creations.filter(path => !present(path)),
    toDelete = deletions.filter(present);
  return {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    files: [...scope.files, ...created],
    ...(toCreate.length ? { create: toCreate } : {}),
    ...(toDelete.length ? { delete: toDelete } : {}),
  };
}

/**
 * The preparation request for the `preparation` or `refresh` stage. Initial preparation may not
 * change repository inputs at all; a slice's own refresh may change only that slice's authorized
 * files, which is why its edit policy becomes the preparation scope. `snapshot` is the full current
 * snapshot the state refers to (`guidedSnapshot`). Throws when no command is approved for the stage
 * or `snapshot` is not the one the state refers to, so a request can never bind to other bytes.
 */
export function preparationSpec(state: GuidedState, snapshot: RepositorySnapshot | null): CheckSpec {
  const slice = currentSlice(state);
  const command =
    state.stage === 'preparation' ? state.plan.preparation : (slice.preparation ?? state.plan.preparation);
  if (!command || !state.snapshot || snapshot?.artifact !== state.snapshot.artifact)
    throw new Error('Preparation requires an approved command and current snapshot');
  const policy =
    state.stage === 'refresh' && slice.preparation && slice.mode !== 'no_change' ? editPolicy(state, snapshot) : null;
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

/** The validation request, bound to the current artifact; throws without a current snapshot. */
export function validationSpec(state: GuidedState): CheckSpec {
  const snapshot = required(state, 'snapshot');
  return {
    ...currentSlice(state).validation,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
  };
}

/**
 * The request of the slice's acceptance check at `index`, bound to the current artifact and the task's
 * active criteria; throws without a current snapshot or when the slice has no such check.
 */
export function acceptanceSpec(state: GuidedState, criteria: string[], index: number): CheckSpec {
  const snapshot = required(state, 'snapshot');
  const command = currentSlice(state).acceptance[index];
  if (!command) throw new Error(`The current slice has no acceptance check ${index + 1}`);
  return {
    ...command,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    criteria,
  };
}

/** The acceptance check a verification step runs: its position, the slice's count and exact request. */
export interface DueAcceptance {
  index: number;
  total: number;
  spec: CheckSpec;
}

/**
 * The first acceptance check without a passed run of exactly its request among `checks`, or null when
 * every one has passed. Requests bind the artifact, so only passes on the current artifact count; a
 * repair runs in a new execution, so it starts again from the first check, while a rerun on the same
 * artifact resumes at the check that stopped. Settlement passes only the checks that existed before
 * the step, so the step's own result never counts towards choosing it.
 */
export function dueAcceptance(
  state: GuidedState,
  criteria: string[],
  checks: readonly Pick<RepositoryCheck, 'phase' | 'spec'>[],
): DueAcceptance | null {
  const total = currentSlice(state).acceptance.length;
  for (let index = 0; index < total; index++) {
    const spec = acceptanceSpec(state, criteria, index);
    if (!checks.some(check => check.phase === 'passed' && deepEqual(check.spec, spec))) return { index, total, spec };
  }
  return null;
}

/**
 * How a stop or repair names an acceptance check's position, such as ` (2 of 3)`; empty for a slice
 * with a single check, whose name alone is unambiguous.
 */
export function acceptancePosition({ index, total }: Pick<DueAcceptance, 'index' | 'total'>): string {
  return total > 1 ? ` (${index + 1} of ${total})` : '';
}

/** The local delivery request for the checked artifact; throws without a current snapshot. */
export function deliverySpec(state: GuidedState): DeliverySpec {
  const snapshot = required(state, 'snapshot'),
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

/**
 * The fresh arbitrator while arbitrating, otherwise the independent reviewer. Arbitration starts only
 * when the plan names an arbitrator, so arbitrating without one is a corrupt state.
 */
export function reviewer(state: GuidedState): GuidedPlan['review'] {
  if (!state.reviewCycle.arbitrating) return state.plan.review;
  const arbitrator = state.plan.reviewPolicy?.arbitrator;
  if (!arbitrator) throw new Error('The guided task is arbitrating but its plan names no arbitrator');
  return arbitrator;
}
