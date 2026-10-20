// Owns the durable comparison contract. The approval binds all run identities and plan digests;
// preference and integration are separate decisions and never change the approved work.
import type { Store } from '../persistence/store.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { guidedPlanSchema, type GuidedPlan } from './guided-plan.js';
import { modelProfileSchema } from './model-profiles.js';
import { profileLimits } from '../config/limits.js';
import { comparisonRetries } from './comparison-retries.js';

/** An exclusive comparison driver owner, retained across an uncertain process exit. */
export const comparisonOwnerSchema = z.object({
  token: z.string(),
  controllerPid: z.number(),
  controllerStartedAt: z.string().nullable(),
  host: z.string(),
});

/** A frozen comparison and its progress; each member remains a normal guided task. */
export const comparisonSchema = z.object({
  revision: z.number().int().min(0),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  sourceTaskId: z.string(),
  plan: guidedPlanSchema,
  sharedDigest: z.string(),
  digest: z.string(),
  approvedDigest: z.string().nullable(),
  planningSessionId: z.string().nullable(),
  runs: z
    .array(z.object({ taskId: z.string(), version: z.number(), digest: z.string(), profile: modelProfileSchema }))
    .min(profileLimits.comparisonMinimumRuns)
    .max(profileLimits.comparisonRuns),
  cursor: z.number().int().min(0),
  pauseRequested: z.boolean(),
  status: z.enum(['draft', 'ready', 'running', 'waiting', 'complete', 'recovery_required']),
  owner: comparisonOwnerSchema.nullable(),
  preferredTaskId: z.string().nullable(),
  note: z.string(),
  integration: z
    .object({
      taskId: z.string(),
      repository: z.string(),
      branch: z.string(),
      base: z.string(),
      commit: z.string(),
      phase: z.enum(['requested', 'integrated', 'recovery_required']),
      owner: comparisonOwnerSchema,
      error: z.string().nullable(),
    })
    .nullable(),
});
export type Comparison = z.infer<typeof comparisonSchema>;

/** The shared work contract, excluding role choices and each isolated workspace's destination. */
export function sharedPlanDigest(plan: GuidedPlan): string {
  const {
    modelProfile: _profile,
    implementation: _implementation,
    review: _review,
    reviewPolicy: _reviewPolicy,
    workspace,
    ...work
  } = plan;
  const { path: _path, ...base } = workspace;
  return createHash('sha256')
    .update(JSON.stringify({ ...work, workspace: base }))
    .digest('hex');
}

/** Binds membership, order, per-run configuration and the shared plan in one batch approval. */
export function comparisonDigest(value: Pick<Comparison, 'id' | 'sharedDigest' | 'runs'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: value.id, sharedDigest: value.sharedDigest, runs: value.runs }))
    .digest('hex');
}

/** Controllers enforce ordering even when a member is addressed through the ordinary task API. */
export function requireComparisonMember(store: Store, taskId: string): void {
  const group = store.comparisons().find(item => item.runs.some(run => run.taskId === taskId));
  if (!group) return;
  if (group.pauseRequested)
    throw new Error('Comparison is paused; continue the comparison before dispatching a member');
  const run = comparisonCurrentRun(store, group);
  if (!run || run.taskId !== taskId || group.approvedDigest !== group.digest)
    throw new Error('This run must wait for its approved comparison turn');
  const task = store.get(taskId);
  if (task.version !== run.version || task.guided?.digest !== run.digest)
    throw new Error('Comparison member configuration changed; create a new comparison');
}

/** An explicit retry temporarily occupies the driver without moving the initial execution cursor. */
export function comparisonCurrentRun(store: Store, group: Comparison): Comparison['runs'][number] | undefined {
  const retry = comparisonRetries(store, group.id).active;
  return retry ? group.runs.find(run => run.taskId === retry.taskId) : group.runs[group.cursor];
}

/** Exact displayed state for user decisions, separate from immutable batch approval. */
export function comparisonDecisionKey(value: Comparison): string {
  return createHash('sha256')
    .update(JSON.stringify({ digest: value.digest, revision: value.revision }))
    .digest('hex');
}
