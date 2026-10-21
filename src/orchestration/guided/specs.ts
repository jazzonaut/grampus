// Owns the exact leaf requests a guided step dispatches: edit policy, preparation, check and
// delivery specs, and the reviewer. Each step builds its request here before dispatch and builds it
// again at settlement, so a result is adopted only if it answers exactly the approved request. These
// are pure functions of the state, snapshot and any check records passed in; nothing here dispatches
// work or writes the journal.
import { commandLimits } from '../../config/limits.js';
import type { GuidedContext } from './context.js';
import type { GuidedAgent } from '../../domain/guided-plan.js';

import type { GuidedPlan, GuidedSlice } from '../../domain/guided-plan.js';
import { selectedEditPasses, type QualityPassDefinition } from '../../domain/quality-passes.js';
import type { EditPolicy } from '../../execution/edit-policy.js';
import type { DeliverySpec } from '../../execution/deliveries.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { CheckSpec, RepositoryCheck } from '../../verification/checks.js';
import { deepEqual } from '../../domain/deep-equal.js';
import { pendingReadiness } from '../../domain/readiness.js';
import { required, type GuidedState, type Stage } from './state.js';

/** The approved first-implementation or repair assignment, decided from retained slice executions. */
export function implementer(
  { id, state, store }: GuidedContext & { state: GuidedState },
  excluding?: string,
): GuidedAgent {
  // Matches the execution's own usage stage (executions.ts): a revision starts every attempt fresh.
  const repairing = store
    .executions(id)
    .some(
      item =>
        item.id !== excluding &&
        item.version === state.version &&
        item.role === 'implementation' &&
        item.sliceIndex === state.sliceIndex,
    );
  return repairing ? (state.plan.modelProfile?.repair ?? state.plan.implementation) : state.plan.implementation;
}

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

/** Binds native workspace execution to the captured artifact; no-change slices do not edit. */
export function editPolicy(state: GuidedState, snapshot: RepositorySnapshot): EditPolicy | null {
  return currentSlice(state).mode === 'no_change'
    ? null
    : { workspace: true, artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: [] };
}

/**
 * The preparation request for the `preparation` or `refresh` stage. Initial preparation may not
 * change repository inputs at all; a slice's own refresh may change only that slice's authorized
 * files, which is why its edit policy becomes the preparation scope. `snapshot` is the full current
 * snapshot the state refers to (`guidedSnapshot`). Throws when no command is approved for the stage
 * or `snapshot` is not the one the state refers to, so a request can never bind to other bytes.
 * `checks` contains only records known before this step, so its own result cannot change its request.
 */
export function preparationSpec(
  state: GuidedState,
  snapshot: RepositorySnapshot | null,
  checks: readonly RepositoryCheck[],
): CheckSpec {
  const slice = currentSlice(state);
  if (!state.snapshot || snapshot?.artifact !== state.snapshot.artifact)
    throw new Error('Preparation requires an approved command and current snapshot');
  const command = preparationCommand(state, snapshot, checks);
  if (!command) throw new Error('Preparation requires an approved command and current snapshot');
  const policy =
    state.stage === 'refresh' && command === slice.preparation && slice.mode !== 'no_change'
      ? editPolicy(state, snapshot)
      : null;
  const scope = preparationScope(policy);
  return {
    ...command,
    artifact: state.snapshot.artifact,
    instructionsDigest: state.snapshot.instructionsDigest,
    preparation: scope ? { scope } : {},
  };
}

/** Generation may update restore inputs; recognise only a settled controller generation of this artifact. */
function preparationCommand(state: GuidedState, snapshot: RepositorySnapshot, checks: readonly RepositoryCheck[]) {
  if (state.stage === 'preparation') return state.plan.preparation;
  const generation = currentSlice(state).preparation;
  if (!generation || !state.plan.preparation?.restore) return generation ?? state.plan.preparation;
  const previous = checks.findLast(
    check =>
      !check.implementationId &&
      check.purpose === 'preparation' &&
      !check.spec.restore &&
      deepEqual(
        [check.spec.name, check.spec.file, check.spec.args, check.spec.timeoutMs],
        [generation.name, generation.file, generation.args, generation.timeoutMs],
      ),
  );
  const generated =
    previous?.phase === 'passed' &&
    !previous.error &&
    previous.result?.reason === 'exited' &&
    previous.result.exitConfirmed &&
    previous.result.exitCode === 0 &&
    previous.after?.artifact === snapshot.artifact &&
    previous.after.instructionsDigest === snapshot.instructionsDigest;
  return generated ? state.plan.preparation : generation;
}

function preparationScope(policy: EditPolicy | null) {
  return policy && (policy.files.length || policy.create?.length || policy.delete?.length || policy.directories?.length)
    ? {
        files: policy.files,
        ...(policy.directories ? { directories: policy.directories } : {}),
        ...(policy.create ? { create: policy.create } : {}),
        ...(policy.delete ? { delete: policy.delete } : {}),
      }
    : undefined;
}

/** The validation request, bound to the current artifact; throws without a current snapshot. */
export function validationSpec(state: GuidedState): CheckSpec {
  const snapshot = required(state, 'snapshot');
  // `regression` decides what happens after a failure; it is not part of what runs.
  const { regression: _regression, ...command } = currentSlice(state).validation;
  return {
    ...command,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
  };
}

/** The first readiness check without a passing result on this exact artifact in this execution. */
export function dueReadiness(
  state: GuidedState,
  checks: readonly (Pick<RepositoryCheck, 'phase' | 'spec'> &
    Partial<Pick<RepositoryCheck, 'result' | 'error' | 'before' | 'after'>>)[],
  collectFailures = false,
): CheckSpec | null {
  return pendingReadiness(currentSlice(state).readiness, required(state, 'snapshot'), checks, collectFailures);
}

/** The next approved independent mechanical checks, bounded by the slice's approved concurrency. */
export function readinessBatch(state: GuidedState, checks: readonly RepositoryCheck[]): CheckSpec[] {
  const observed: Pick<RepositoryCheck, 'phase' | 'spec'>[] = [...checks];
  const result: CheckSpec[] = [];
  while (result.length < currentSlice(state).readinessConcurrency) {
    const next = dueReadiness(state, observed, true);
    if (!next) break;
    result.push(next);
    observed.push({ phase: 'passed', spec: next });
  }
  return result;
}

/**
 * The request of the slice's acceptance check at `index`, bound to the current artifact and the task's
 * active criteria; throws without a current snapshot or when the slice has no such check.
 */
export function acceptanceSpec(state: GuidedState, criteria: string[], index: number): CheckSpec {
  const snapshot = required(state, 'snapshot');
  const approved = currentSlice(state).acceptance[index];
  if (!approved) throw new Error(`The current slice has no acceptance check ${index + 1}`);
  const { regression: _regression, ...command } = approved;
  return {
    ...command,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    criteria,
  };
}

/**
 * Whether the approved validation or acceptance command behind `spec` guards existing behaviour, so a
 * failure is worth rerunning on the starting commit. Acceptance names are distinct within a slice.
 */
export function regressionCheck(state: GuidedState, spec: Pick<CheckSpec, 'name' | 'criteria'>): boolean {
  const slice = currentSlice(state);
  const command = spec.criteria ? slice.acceptance.find(item => item.name === spec.name) : slice.validation;
  return command?.regression === true;
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

/** Agents finish setup before submission, so a candidate proceeds directly to controller checks. */
export function afterImplementation(state: GuidedState): Stage {
  return afterPreparation(state);
}

/** Readiness runs after prerequisite refresh and before behavioural validation on every attempt. */
export function afterPreparation(state: GuidedState): Stage {
  return currentSlice(state).readiness.length ? 'readiness' : 'validation';
}

/** The next selected edit pass that has not yet run in this slice, or null. */
export function pendingEditPass(state: GuidedState): QualityPassDefinition | null {
  return (
    selectedEditPasses(state.plan.quality).find(
      pass =>
        !!state.plan.modelProfile?.qualityPasses?.[pass.id] && !state.qualityEdits.some(done => done.pass === pass.id),
    ) ?? null
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
