// Owns the shape of the guided task state saved in the task record, its schema (validated whenever a
// task is read from the journal) and the injectable services the controller and its tests use.
// Behaviour lives in the controller and stage handlers, not here.
import { z } from 'zod';
import type { Workspaces } from '../../repository/workspaces.js';
import { qualityAssessmentRecordSchema } from '../../domain/quality-passes.js';
import { editPolicySchema } from '../../execution/edit-policy.js';
import type { Connector } from '../../providers/types.js';
import { guidedPlanSchema } from '../../domain/guided-plan.js';
import type { CheckProcessOptions, CheckProcessResult } from '../../process/check-process.js';
import { stopReasonSchema } from './stop-reasons.js';
import { snapshotRefSchema } from './snapshots.js';

/** The ordered guided steps; `complete` is terminal and has no handler. */
export const stageSchema = z.enum([
  'workspace',
  'execution',
  'preparation',
  'scope',
  'implementation',
  'quality_pass',
  'refresh',
  'validation',
  'submission',
  'assessment',
  'review_execution',
  'review',
  'verification',
  'delivery',
  'complete',
]);
export type Stage = z.infer<typeof stageSchema>;

/** Every stage that dispatches work. */
export type ActiveStage = Exclude<Stage, 'complete'>;

/** Guided task status. Stop statuses always carry a {@link StopReason}. */
export const statusSchema = z.enum([
  'draft',
  'ready',
  'running',
  'awaiting_scope',
  'awaiting_assessment',
  'awaiting_answer',
  'blocked',
  'recovery_required',
  'complete',
]);
export type Status = z.infer<typeof statusSchema>;

/** Statuses waiting for a person to supply something before the controller continues. */
export type WaitStatus = Extract<Status, 'awaiting_scope' | 'awaiting_assessment' | 'awaiting_answer'>;

/** Statuses in which the controller is making, or may immediately make, progress. */
const progressStatuses: ReadonlySet<Status> = new Set<Status>(['ready', 'running', 'complete']);

/** Whether a status means work is progressing, so no stop reason applies. */
export function isProgressStatus(status: Status): boolean {
  return progressStatuses.has(status);
}

/**
 * The controller process that owns the runner; compared against lease records to prove origin.
 * `controllerStartedAt` is null when the creation time could not be observed (for example off
 * Windows). Recovery then stays conservative: the owner counts as dead only when no process at all
 * has its PID, so a recycled PID keeps it alive.
 */
export const ownerSchema = z.object({
  token: z.string(),
  controllerPid: z.number(),
  controllerStartedAt: z.string().nullable(),
  host: z.string(),
});
export type Owner = z.infer<typeof ownerSchema>;

/**
 * A journaled step intent. `known` lists the result ids that existed before dispatch, so settlement
 * adopts exactly one new result and never mistakes an older one for this step's.
 */
export const pendingSchema = z.object({
  stage: stageSchema,
  known: z.array(z.string()),
  /** The assessment an `assessment` step records: the head of the queue when the step began. */
  assessment: qualityAssessmentRecordSchema.nullable(),
  controller: ownerSchema,
});
export type Pending = z.infer<typeof pendingSchema>;

/** Shared repair spending for the current slice; survives manual retry and restarts. */
export const repairCycleSchema = z.object({
  used: z.number(),
  /** Failed artifacts per purpose; a repeat on the same artifact means the repair made no progress. */
  failures: z.array(z.object({ purpose: z.string(), artifact: z.string(), issue: z.string() })),
});
export type RepairCycle = z.infer<typeof repairCycleSchema>;

/** Review's share of repair spending and arbitration history for the current slice. */
export const reviewCycleSchema = z.object({
  repairs: z.number(),
  /** Every blocking verdict for this slice; resent to later reviewers in full. */
  history: z.array(z.object({ executionId: z.string(), artifact: z.string() })),
  arbitrating: z.boolean(),
  arbitrationUsed: z.boolean(),
});
export type ReviewCycle = z.infer<typeof reviewCycleSchema>;

/**
 * An edit pass that settled in the current slice. Edit passes run once per slice, after its first
 * successful implementation turn, so a later repair attempt skips every pass recorded here.
 */
export const qualityEditRecordSchema = z.object({
  pass: z.string(),
  /** The implementation run that applied the pass. */
  implementationId: z.string(),
  /** Artifact before and after the pass; equal when the pass changed nothing. */
  before: z.string(),
  after: z.string(),
});
export type QualityEditRecord = z.infer<typeof qualityEditRecordSchema>;

/** A new slice or revised plan starts with an unused shared repair allowance. */
export const freshRepairCycle = (): RepairCycle => ({ used: 0, failures: [] });

/** A new slice or revised plan starts with no review repair spending or arbitration history. */
export const freshReviewCycle = (): ReviewCycle => ({
  repairs: 0,
  history: [],
  arbitrating: false,
  arbitrationUsed: false,
});

/**
 * The guided state saved in the task record. Changes only through the controller. Validated in place
 * on every task read (persistence/records.ts `taskSchema`), so a malformed record is a journal
 * boundary error naming the field rather than an undefined value discovered mid-step.
 */
export const guidedStateSchema = z.object({
  /** The previous implementation execution, whose conversation an automatic retry may resume. */
  implementationContinuation: z.string().nullable(),
  /** The previous review execution, whose conversation a later review by the same provider may resume. */
  reviewContinuation: z.string().nullable(),
  /** Automatic repairs must find exactly this artifact at scope, so no external change is adopted. */
  retryAnchor: z.object({ artifact: z.string(), instructionsDigest: z.string() }).nullable(),
  /** The failed check on display; what rerun checks repeats and a repair quotes as evidence. */
  failedCheckId: z.string().nullable(),
  repairCycle: repairCycleSchema,
  reviewCycle: reviewCycleSchema,
  version: z.number(),
  plan: guidedPlanSchema,
  /** The digest of `plan`; approval names it, and work runs only while `approvedDigest` equals it. */
  digest: z.string(),
  approvedDigest: z.string().nullable(),
  status: statusSchema,
  stage: stageSchema,
  sliceIndex: z.number(),
  workspaceId: z.string().nullable(),
  executionId: z.string().nullable(),
  reviewId: z.string().nullable(),
  validationId: z.string().nullable(),
  /** The current snapshot by reference; the content is in the `snapshots` table (`guidedSnapshot`). */
  snapshot: snapshotRefSchema.nullable(),
  policy: editPolicySchema.nullable(),
  /** The runner owner. It never expires; only recovery displaces a provably dead one. */
  owner: ownerSchema.nullable(),
  /** The step intent journaled before dispatch; non-null afterwards means the step needs settlement. */
  pending: pendingSchema.nullable(),
  /** A persisted stop request, forwarded by the owning controller to the running leaf as an abort. */
  stopRequested: z.boolean(),
  /** Finish the current operation, then wait for explicit continuation without aborting it. */
  pauseRequested: z.boolean(),
  /** Lens assessments still to record on the current artifact, one per `assessment` step. */
  assessments: z.array(qualityAssessmentRecordSchema),
  /** Edit passes already applied in the current slice. */
  qualityEdits: z.array(qualityEditRecordSchema),
  /** Answers to the current agent questions, keyed by question id, until the next turn consumes them. */
  answers: z.record(z.string(), z.string()).nullable(),
  /** Bounded evidence from the previous attempt for the next implementation prompt; empty at first. */
  feedback: z.string(),
  note: z.string(),
  /** Why the task stopped; null while it is progressing. */
  stopReason: stopReasonSchema.nullable(),
});
export type GuidedState = z.infer<typeof guidedStateSchema>;

/** State fields that stay null until the step that sets them has run. */
type StepField =
  | 'workspaceId'
  | 'executionId'
  | 'reviewId'
  | 'validationId'
  | 'failedCheckId'
  | 'snapshot'
  | 'policy'
  | 'owner'
  | 'pending';

const stepFieldLabels: Record<StepField, string> = {
  workspaceId: 'workspace',
  executionId: 'implementation execution',
  reviewId: 'review execution',
  validationId: 'passing validation',
  failedCheckId: 'failed check',
  snapshot: 'current snapshot',
  policy: 'edit policy',
  owner: 'runner owner',
  pending: 'pending step',
};

/**
 * The value of `field`, for code that is reachable only after the step that sets it (a stage after
 * `execution` always has an execution, for example). A null value means the record and its stage
 * disagree, so this throws a descriptive error rather than letting a step run against nothing.
 */
export function required<K extends StepField>(
  state: Pick<GuidedState, K | 'stage'>,
  field: K,
): NonNullable<GuidedState[K]> {
  const value: GuidedState[K] = state[field];
  if (value === null || value === undefined)
    throw new Error(`The guided task has no ${stepFieldLabels[field]} at stage ${state.stage}`);
  return value;
}

/** Replaceable collaborators; production uses the defaults, tests inject offline fakes. */
export interface GuidedServices {
  /** A decision key the caller inspected; every action refuses a task that has changed since. */
  expectedState?: string;
  workspaces?: Workspaces;
  implementationRunner?: (options: CheckProcessOptions) => Promise<CheckProcessResult>;
  preparationRunner?: (options: CheckProcessOptions) => Promise<CheckProcessResult>;
  connector?: Connector;
}
