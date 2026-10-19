// Owns the shape of the guided task state saved in the task record, and the injectable services the
// controller and its tests use. Behaviour lives in the controller and stage handlers.
import type { Workspaces } from '../../repository/workspaces.js';
import type { QualityAssessment } from '../../domain/quality-passes.js';
import type { EditPolicy } from '../../execution/edit-policy.js';
import type { Connector } from '../../providers/types.js';
import type { GuidedPlan } from '../../domain/guided-plan.js';
import type { CheckProcessOptions, CheckProcessResult } from '../../process/check-process.js';
import type { StopReason } from './stop-reasons.js';
import type { SnapshotRef } from './snapshots.js';

/** The ordered guided steps; `complete` is terminal and has no handler. */
export type Stage =
  | 'workspace'
  | 'execution'
  | 'preparation'
  | 'scope'
  | 'implementation'
  | 'quality_pass'
  | 'refresh'
  | 'validation'
  | 'submission'
  | 'assessment'
  | 'review_execution'
  | 'review'
  | 'verification'
  | 'delivery'
  | 'complete';

/** Every stage that dispatches work. */
export type ActiveStage = Exclude<Stage, 'complete'>;

/** Guided task status. Stop statuses always carry a {@link StopReason}. */
export type Status =
  | 'draft'
  | 'ready'
  | 'running'
  | 'awaiting_scope'
  | 'awaiting_assessment'
  | 'awaiting_answer'
  | 'blocked'
  | 'recovery_required'
  | 'complete';

/** Statuses waiting for a person to supply something before the controller continues. */
export type WaitStatus = Extract<Status, 'awaiting_scope' | 'awaiting_assessment' | 'awaiting_answer'>;

/** Statuses in which the controller is making, or may immediately make, progress. */
const progressStatuses: ReadonlySet<Status> = new Set<Status>(['ready', 'running', 'complete']);

/** Whether a status means work is progressing, so no stop reason applies. */
export function isProgressStatus(status: Status): boolean {
  return progressStatuses.has(status);
}

/** The controller process that owns the runner; compared against lease records to prove origin. */
export interface Owner {
  token: string;
  controllerPid: number;
  controllerStartedAt: string | null;
  host: string;
}

/**
 * A journaled step intent. `known` lists the result ids that existed before dispatch, so settlement
 * adopts exactly one new result and never mistakes an older one for this step's.
 */
export interface Pending {
  stage: Stage;
  known: string[];
  /** The assessment an `assessment` step records: the head of the queue when the step began. */
  assessment: QualityAssessment | null;
  controller: Owner;
}

/** Check repair spending for the current slice; survives manual retry and restarts. */
export interface RepairCycle {
  used: number;
  /** Failed artifacts per purpose; a repeat on the same artifact means the repair made no progress. */
  failures: { purpose: string; artifact: string; issue: string }[];
}

/** Review repair and arbitration spending for the current slice. */
export interface ReviewCycle {
  repairs: number;
  /** Every blocking verdict for this slice; resent to later reviewers in full. */
  history: { executionId: string; artifact: string }[];
  arbitrating: boolean;
  arbitrationUsed: boolean;
}

/**
 * An edit pass that settled in the current slice. Edit passes run once per slice, after its first
 * successful implementation turn, so a later repair attempt skips every pass recorded here.
 */
export interface QualityEditRecord {
  pass: string;
  /** The implementation run that applied the pass. */
  implementationId: string;
  /** Artifact before and after the pass; equal when the pass changed nothing. */
  before: string;
  after: string;
}

/** A new slice or revised plan starts with an unused check repair allowance. */
export const freshRepairCycle = (): RepairCycle => ({ used: 0, failures: [] });

/** A new slice or revised plan starts with an unused review repair allowance. */
export const freshReviewCycle = (): ReviewCycle => ({
  repairs: 0,
  history: [],
  arbitrating: false,
  arbitrationUsed: false,
});

/** The guided state saved in the task record. Changes only through the controller. */
export interface GuidedState {
  implementationContinuation: string | null;
  reviewContinuation: string | null;
  retryAnchor: { artifact: string; instructionsDigest: string } | null;
  failedCheckId: string | null;
  repairCycle: RepairCycle;
  reviewCycle: ReviewCycle;
  version: number;
  plan: GuidedPlan;
  digest: string;
  approvedDigest: string | null;
  status: Status;
  stage: Stage;
  sliceIndex: number;
  workspaceId: string | null;
  executionId: string | null;
  reviewId: string | null;
  validationId: string | null;
  /** The current snapshot by reference; the content is in the `snapshots` table (`guidedSnapshot`). */
  snapshot: SnapshotRef | null;
  policy: EditPolicy | null;
  owner: Owner | null;
  pending: Pending | null;
  stopRequested: boolean;
  /** Lens assessments still to record on the current artifact, one per `assessment` step. */
  assessments: QualityAssessment[];
  /** Edit passes already applied in the current slice. */
  qualityEdits: QualityEditRecord[];
  answers: Record<string, string> | null;
  feedback: string;
  note: string;
  /** Why the task stopped; null while it is progressing. */
  stopReason: StopReason | null;
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
