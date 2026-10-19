// Owns plan revision at an idle checkpoint: validating that a revised plan preserves delivered slices
// and the retained workspace, and building the fresh draft state that needs new approval.
import type { Task } from '../../domain/workflow.js';
import { deepEqual } from '../../domain/deep-equal.js';
import { guidedPlanDigest, normalizeGuidedPlan, type GuidedPlan } from '../../domain/guided-plan.js';
import type { Session } from '../../execution/sessions.js';
import { snapshotRepository, type RepositorySnapshot } from '../../repository/artifacts.js';
import type { GuidedContext } from './context.js';
import { freshRepairCycle, freshReviewCycle, type GuidedState } from './state.js';
import { stopReason } from './stop-reasons.js';
import type { SnapshotRef } from './snapshots.js';

/** Slice deliveries already recorded on the task. */
export type CompletedSlices = NonNullable<Task['slice']>['completed'];

/** A validated revision, ready to commit. */
export interface RevisionDraft {
  plan: GuidedPlan;
  /** The retained workspace snapshot the revision is approved against, if a workspace exists. */
  anchor: RepositorySnapshot | null;
  workspaceId: string | null;
  completed: CompletedSlices;
}

/** Delivered slices are history: their brief and execution configuration must be unchanged. */
function requirePreservedPrefix(plan: GuidedPlan, observed: GuidedState, completed: CompletedSlices): void {
  for (let index = 0; index < completed.length; index++) {
    if (
      !deepEqual(plan.brief.slices?.[index], observed.plan.brief.slices?.[index]) ||
      !deepEqual(plan.slices[index], observed.plan.slices[index])
    )
      throw new Error('Delivered slices cannot be rewritten; revise remaining slices or append a follow-up slice');
  }
  if (completed.length && plan.slices.length <= completed.length)
    throw new Error('The revised plan needs at least one remaining slice');
}

/**
 * Normalises and validates a revised plan against the observed state. The retained workspace is
 * snapshotted twice so the revision binds to bytes that were stable while it was prepared; that
 * snapshot becomes the revision anchor the next execution must still match.
 */
export async function draftRevision(
  { id, workspaces, workflow }: GuidedContext,
  observed: GuidedState,
  input: unknown,
  directory?: string,
): Promise<RevisionDraft> {
  const workspace = observed.workspaceId ? (await workspaces.inspect(observed.workspaceId, false)).workspace : null;
  const anchor = workspace ? await snapshotRepository(workspace.path!, workspace.baseCommit) : null;
  const editable = structuredClone(input) as Record<string, unknown>;
  if (editable && typeof editable === 'object') delete editable['revision'];
  const plan = normalizeGuidedPlan(editable, directory, workspace ? observed.plan.workspace : undefined);
  if (workspace && !deepEqual(plan.workspace, observed.plan.workspace))
    throw new Error('A revision must preserve the repository, pinned base and workspace identity');
  const completed = structuredClone(workflow.get(id).slice?.completed ?? []);
  requirePreservedPrefix(plan, observed, completed);
  if (anchor) {
    const again = await snapshotRepository(workspace!.path!, workspace!.baseCommit);
    if (
      again.artifact !== anchor.artifact ||
      again.instructionsDigest !== anchor.instructionsDigest ||
      again.head !== anchor.head
    )
      throw new Error('Workspace changed while preparing the revision; inspect it again');
    plan.revision = {
      previousVersion: observed.version,
      artifact: anchor.artifact,
      head: anchor.head,
      instructionsDigest: anchor.instructionsDigest,
      sliceIndex: completed.length,
    };
  }
  return { plan, anchor, workspaceId: workspace?.id ?? null, completed };
}

/** Refuses a revision while any agent session linked to the task is active or uncertain. */
export function requireLinkedSessionsSettled({ id, store, executions }: GuidedContext): void {
  const linked = executions.list().filter(execution => execution.taskId === id);
  if (
    linked.some(execution => {
      const session = store.session<Session>(execution.sessionId);
      return session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase);
    })
  )
    throw new Error('Settle or recover all linked agent sessions before revising');
  for (const execution of linked) if (execution.phase !== 'closed') executions.close(execution.id);
}

const revisionNote =
  'Inspect the revised plan and retained workspace changes. Fresh plan approval and file authorization are required; previous checks and reviews do not carry forward.';

/**
 * The draft state of a revised plan. Workspace and delivered prefix are kept; every attempt,
 * allowance, conversation and piece of evidence starts fresh, because none of it was produced under
 * the revised plan.
 */
export function revisedState(
  state: GuidedState,
  draft: RevisionDraft,
  version: number,
  anchor: SnapshotRef | null,
): GuidedState {
  return {
    ...state,
    version,
    plan: draft.plan,
    digest: guidedPlanDigest(draft.plan),
    approvedDigest: null,
    implementationContinuation: null,
    reviewContinuation: null,
    retryAnchor: null,
    failedCheckId: null,
    repairCycle: freshRepairCycle(),
    status: 'draft',
    stage: draft.workspaceId ? 'execution' : 'workspace',
    sliceIndex: draft.completed.length,
    executionId: null,
    reviewId: null,
    validationId: null,
    snapshot: anchor,
    policy: null,
    pending: null,
    assessments: [],
    qualityEdits: [],
    answers: null,
    feedback: '',
    reviewCycle: freshReviewCycle(),
    stopRequested: false,
    note: revisionNote,
    stopReason: stopReason('APPROVAL_REQUIRED', revisionNote),
  };
}
