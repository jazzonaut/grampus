// Owns the task record and its gates: the brief, versions and approval, attempts, artifact-bound
// evidence, decisions and slice progress. `Workflow` is the only code that changes a task's phase;
// it trusts its caller (the controller) and never validates provider messages itself.
import type { GuidedState } from '../orchestration/guided/state.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { planLimits } from '../config/limits.js';
import { selectedLenses } from './quality-passes.js';
import type { Store } from '../persistence/store.js';
import { assertTaskExecutionIdle } from '../execution/execution-state.js';
import type { Delivery, Execution } from '../persistence/records.js';

/** One ordered slice of a brief: an independently verifiable outcome naming the task criteria it delivers. */
export const sliceSchema = z.object({ title: z.string(), plan: z.string(), criteria: z.array(z.string()) });
export type Slice = z.infer<typeof sliceSchema>;

/** What the task must achieve. `slices`, when present, cover every criterion; see {@link validateBrief}. */
export const briefSchema = z.object({
  title: z.string(),
  outcome: z.string(),
  criteria: z.array(z.string()),
  plan: z.string(),
  slices: z.array(sliceSchema).exactOptional(),
});
export type Brief = z.infer<typeof briefSchema>;

/** The provider session an attempt or a review ran in. Review independence compares these. */
export const agentSchema = z.object({ provider: z.string(), model: z.string(), sessionId: z.string() });
export type Agent = z.infer<typeof agentSchema>;

/** One implementation try. A fresh id per try is what invalidates evidence from earlier tries. */
export const attemptSchema = z.object({
  id: z.string(),
  version: z.number(),
  agent: agentSchema,
  /** The content digest the attempt finished with; null until it succeeds. */
  artifact: z.string().nullable(),
  /** `uncertain` after a controller restart while running: the outcome must be reconciled, never assumed. */
  outcome: z.enum(['running', 'succeeded', 'failed', 'stopped', 'uncertain']),
});
export type Attempt = z.infer<typeof attemptSchema>;

/**
 * One gate result bound to an attempt, version and artifact. `quality` evidence is a lens assessment
 * and names its quality pass in `pass`; no other kind has a pass.
 */
export const evidenceSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  version: z.number(),
  artifact: z.string(),
  kind: z.enum(['quality', 'validation', 'review', 'verification']),
  pass: z.string().exactOptional(),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  summary: z.string(),
  /** Who established it. Agent evidence can never establish validation or verification. */
  source: z.enum(['controller', 'agent', 'synthetic']),
  /** The reviewer's session, required for review evidence. */
  agent: agentSchema.exactOptional(),
  /** The criteria a verification covered. */
  criteria: z.array(z.string()).exactOptional(),
  /** Why a review used the implementer's provider; required in that case. */
  fallbackReason: z.string().exactOptional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * The task phase. `running`, `stop_requested` and `recovery_required` mean a provider or process may
 * still be working, so the record cannot be revised until the work is settled or reconciled.
 */
export const phaseSchema = z.enum([
  'draft',
  'ready',
  'running',
  'stop_requested',
  'recovery_required',
  'stopped',
  'failed',
  'awaiting_verification',
  'awaiting_decision',
  'complete',
]);
export type Phase = z.infer<typeof phaseSchema>;

/** A provisional decision; pending ones block completion and survive revisions until accepted. */
const decisionSchema = z.object({ id: z.string(), version: z.number(), rationale: z.string(), accepted: z.boolean() });

/** A delivered slice: the attempt and artifact it delivered and the head it left behind. */
const completedSliceSchema = z.object({
  index: z.number(),
  attemptId: z.string(),
  artifact: z.string(),
  deliveryId: z.string(),
  outcome: z.enum(['committed', 'no_change']),
  commit: z.string().nullable(),
  /** The commit a no-change delivery verified, or the new commit; the next slice builds on it. */
  head: z.string(),
});

/**
 * Every task field except the guided state. The complete stored record, with `guided` validated by its
 * owner in orchestration/, is `taskSchema` in persistence/records.ts; it is composed there because the
 * guided plan itself depends on this module.
 */
export const taskFieldsSchema = z.object({
  /** Set by the dashboard's delete; a deleted task refuses every change. */
  deletedAt: z.string().exactOptional(),
  /** Set by a dashboard reset: the id of the kickoff that replaced this task. */
  resetTo: z.string().exactOptional(),
  id: z.string(),
  brief: briefSchema,
  version: z.number(),
  approvedVersion: z.number().nullable(),
  phase: phaseSchema,
  /** Only a task created synthetic (the demo) accepts synthetic evidence; it can never be changed. */
  synthetic: z.boolean(),
  attempt: attemptSchema.nullable(),
  /** Evidence for the current attempt only; a new attempt clears it. */
  evidence: z.array(evidenceSchema),
  decisions: z.array(decisionSchema),
  /** Present exactly when the brief has slices. `completed.length === index` until the final delivery. */
  slice: z.object({ index: z.number(), completed: z.array(completedSliceSchema) }).exactOptional(),
});

type CompletedSlice = z.infer<typeof completedSliceSchema>;

/** The stored task record. Changes only through {@link Workflow} and the guided controller. */
export type Task = z.infer<typeof taskFieldsSchema> & { guided?: GuidedState };

/**
 * The quality lenses whose latest assessment must pass before delivery: the plan's selected lenses
 * for a guided task, and the built-in simplification lens for a task driven by the low-level commands.
 */
export function requiredQualityLenses(task: Task): string[] {
  return task.guided ? selectedLenses(task.guided.plan.quality).map(pass => pass.id) : ['simplification'];
}

/** The brief's slices; throws when a task tracks slice progress without them, a corrupt record. */
function plannedSlices(task: Task): Slice[] {
  if (!task.brief.slices) throw new Error(`Task ${task.id} tracks slice progress but its brief has no slices`);
  return task.brief.slices;
}

/** The slice at `index` of the brief; throws when the index is past the planned slices. */
function plannedSlice(task: Task, index: number): Slice {
  const slice = plannedSlices(task)[index];
  if (!slice) throw new Error(`Task ${task.id} has no slice ${index + 1}`);
  return slice;
}

/** The current attempt, for transitions that are only reachable once one has started. */
function currentAttempt(task: Task): Attempt {
  if (!task.attempt) throw new Error(`Task ${task.id} has no current attempt`);
  return task.attempt;
}

/**
 * The criteria the current attempt must satisfy: the current slice's own criteria for an intermediate
 * slice, and every task criterion otherwise, because final verification covers the whole outcome,
 * including earlier slices.
 */
export function activeCriteria(task: Task): string[] {
  const index = task.slice?.index ?? 0;
  return task.slice && task.brief.slices && index < task.brief.slices.length - 1
    ? plannedSlice(task, index).criteria
    : task.brief.criteria;
}

/** The current slice with its active criteria and position, or null for an unsliced task. */
export function activeSlice(task: Task): (Slice & { number: number; total: number; final: boolean }) | null {
  if (!task.brief.slices || !task.slice) return null;
  const index = task.slice.index;
  return {
    ...plannedSlice(task, index),
    criteria: activeCriteria(task),
    number: index + 1,
    total: task.brief.slices.length,
    final: index === task.brief.slices.length - 1,
  };
}

function nonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must not be empty`);
}

/** The criteria one slice names; throws unless they are a nonempty, distinct subset of the task's. */
function sliceCriteria(value: unknown, criteria: string[]): string[] {
  const invalid = new Error('Slice criteria must name distinct approved task criteria');
  if (!Array.isArray(value) || value.length === 0) throw invalid;
  const names: string[] = [];
  const list: unknown[] = value;
  for (const name of list) {
    if (typeof name !== 'string' || !criteria.includes(name) || names.includes(name)) throw invalid;
    names.push(name);
  }
  return names;
}

/** Throws unless every slice is a well-formed, distinct subset of the approved criteria and together they cover all. */
function validateSlices(slices: unknown, criteria: string[]): void {
  if (!Array.isArray(slices) || slices.length < 1 || slices.length > planLimits.slices)
    throw new Error(`Plan requires 1–${planLimits.slices} ordered slices`);
  const list: unknown[] = slices;
  const parsed = list.map(item => {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some(key => !['title', 'plan', 'criteria'].includes(key))
    )
      throw new Error('Invalid slice');
    const slice: Partial<Record<keyof Slice, unknown>> = item;
    nonempty(slice.title, 'slice title');
    nonempty(slice.plan, 'slice plan');
    return sliceCriteria(slice.criteria, criteria);
  });
  if (!criteria.every(criterion => parsed.some(sliceCriteria => sliceCriteria.includes(criterion))))
    throw new Error('Slices must cover every task criterion');
}

/**
 * Validates a brief before it is created or revised: nonempty text, distinct criteria and, when sliced,
 * 1 to `planLimits.slices` slices that each name distinct task criteria and together cover every one.
 * Throws a message naming the first problem.
 */
export function validateBrief(brief: unknown): asserts brief is Brief {
  if (!brief || typeof brief !== 'object') throw new Error('Invalid brief');
  const fields: Partial<Record<keyof Brief, unknown>> = brief;
  nonempty(fields.title, 'title');
  nonempty(fields.outcome, 'outcome');
  nonempty(fields.plan, 'plan');
  if (!Array.isArray(fields.criteria) || fields.criteria.length === 0) throw new Error('Acceptance criteria required');
  const list: unknown[] = fields.criteria;
  const criteria = list.map(value => {
    nonempty(value, 'criterion');
    return value;
  });
  if (new Set(criteria).size !== criteria.length) throw new Error('Acceptance criteria must be distinct');
  if (fields.slices !== undefined) validateSlices(fields.slices, criteria);
}

function validateAgent(agent: Agent): void {
  nonempty(agent.provider, 'provider');
  nonempty(agent.model, 'model');
  nonempty(agent.sessionId, 'sessionId');
}

/** Phases in which a provider or process may still be working, so the record cannot be revised. */
function unsettled(task: Task): boolean {
  return ['running', 'stop_requested', 'recovery_required'].includes(task.phase);
}

/** Throws unless `evidence` has a known kind, outcome and source, and a pass exactly when it is `quality`. */
function validateEvidenceShape(evidence: Evidence): void {
  nonempty(evidence.id, 'evidence id');
  nonempty(evidence.summary, 'summary');
  if (
    !['quality', 'validation', 'review', 'verification'].includes(evidence.kind) ||
    (evidence.kind === 'quality') !== (typeof evidence.pass === 'string' && evidence.pass.trim() !== '') ||
    !['passed', 'failed', 'skipped'].includes(evidence.outcome) ||
    !['controller', 'agent', 'synthetic'].includes(evidence.source)
  )
    throw new Error('Invalid evidence');
}

/**
 * The completed-slice record for `delivery`, after proving it belongs to the current attempt, version
 * and artifact of this task and to the next undelivered slice.
 */
function deliveredSlice(
  task: Task,
  delivery: Delivery,
  execution: Execution,
): { progress: NonNullable<Task['slice']>; record: CompletedSlice } {
  const progress = task.slice;
  const attempt = task.attempt;
  const outcome = delivery.outcome;
  if (
    !progress ||
    !attempt?.artifact ||
    task.phase === 'complete' ||
    delivery.phase !== 'delivered' ||
    !delivery.request ||
    execution.taskId !== task.id ||
    execution.version !== task.version ||
    execution.role !== 'implementation' ||
    execution.attemptId !== attempt.id ||
    delivery.spec.artifact !== attempt.artifact ||
    (outcome !== 'committed' && outcome !== 'no_change') ||
    (outcome === 'committed' && !delivery.commit) ||
    progress.completed.length !== progress.index
  )
    throw new Error('Delivery does not match the current undelivered slice');
  return {
    progress,
    record: {
      index: progress.index,
      attemptId: attempt.id,
      artifact: attempt.artifact,
      deliveryId: delivery.id,
      outcome,
      commit: delivery.commit,
      head: delivery.commit ?? delivery.request.snapshot.head,
    },
  };
}

/**
 * Trusted controller API over task records. Provider messages must be validated before calling it.
 * Every change runs in one store transaction with its journal event, and refuses a deleted task.
 */
export class Workflow {
  constructor(private readonly store: Store) {}

  /** The validated task record; throws as {@link Store.get} does when it is missing or malformed. */
  get(id: string): Task {
    return this.store.get(id);
  }
  /** Every task record, including deleted ones. */
  list(): Task[] {
    return this.store.list();
  }

  /**
   * Reads, changes and saves one task inside a single store transaction, so the check against the
   * current record and the write that depends on it cannot interleave with another writer. `action`
   * mutates the task in place and journals its own events; throwing rolls back both.
   */
  private change<T>(id: string, action: (task: Task) => T): T {
    return this.store.transaction(() => {
      const task = this.get(id);
      if (task.deletedAt) throw new Error('This task was deleted from the dashboard');
      const result = action(task);
      this.store.save(id, task);
      return result;
    });
  }

  private event(task: Task, type: string, data: unknown): void {
    this.store.append(task.id, task.version, type, data);
  }

  /**
   * Throws unless no execution of the task holds a lease and its workspace (if any) has settled.
   * `requireCurrent` also requires the workspace to exist for the current version, as starting an
   * attempt does; a released workspace is otherwise acceptable.
   */
  private workspaceSettled(task: Task, requireCurrent = false): void {
    assertTaskExecutionIdle(this.store, task.id);
    const workspace = this.store.workspaces().find(item => item.taskId === task.id);
    if (!workspace) return;
    if (workspace.phase === 'released' && !requireCurrent) return;
    if (workspace.phase !== 'ready') throw new Error('Settle or reconcile workspace creation first');
    if (requireCurrent && workspace.version !== task.version)
      throw new Error('Workspace belongs to an earlier task version');
  }

  /** Creates a draft task at version 1. `synthetic` is fixed for the task's lifetime. */
  create(brief: Brief, synthetic = false): Task {
    validateBrief(brief);
    const task: Task = {
      id: randomUUID(),
      brief: structuredClone(brief),
      version: 1,
      approvedVersion: null,
      phase: 'draft',
      synthetic,
      attempt: null,
      evidence: [],
      decisions: [],
      ...(brief.slices ? { slice: { index: 0, completed: [] } } : {}),
    };
    this.store.transaction(() => {
      this.store.save(task.id, task);
      this.event(task, 'task.created', { brief, synthetic });
    });
    return task;
  }

  /**
   * Replaces the brief as a new unapproved version, clearing the attempt, evidence and slice progress.
   * Refused on a version conflict or while work may still be running.
   */
  revise(id: string, expectedVersion: number, brief: Brief): void {
    validateBrief(brief);
    this.change(id, task => {
      if (task.version !== expectedVersion) throw new Error('Version conflict');
      if (unsettled(task)) throw new Error('Settle or reconcile active work before revising');
      this.workspaceSettled(task);
      task.version++;
      task.brief = structuredClone(brief);
      task.approvedVersion = null;
      task.attempt = null;
      task.evidence = [];
      if (brief.slices) task.slice = { index: 0, completed: [] };
      else delete task.slice;
      // Pending decisions survive revisions until explicitly accepted.
      task.phase = 'draft';
      this.event(task, 'task.revised', { brief, previousVersion: expectedVersion });
    });
  }

  /** Approves exactly `version`; an outdated version is refused so approval never covers unseen changes. */
  approve(id: string, version: number): void {
    this.change(id, task => {
      if (version !== task.version) throw new Error('Cannot approve an outdated version');
      if (task.phase !== 'draft') throw new Error('Only a draft can be approved');
      task.approvedVersion = version;
      task.phase = 'ready';
      this.event(task, 'plan.approved', { version });
    });
  }

  /** Starts a fresh attempt on the approved version, clearing all evidence of earlier attempts. */
  start(id: string, agent: Agent): Attempt {
    validateAgent(agent);
    return this.change(id, task => {
      if (task.approvedVersion !== task.version) throw new Error('Current plan needs approval');
      this.workspaceSettled(task, true);
      if (!['ready', 'stopped', 'failed', 'awaiting_verification', 'awaiting_decision'].includes(task.phase)) {
        throw new Error('Task cannot start in its current state');
      }
      task.attempt = {
        id: randomUUID(),
        version: task.version,
        agent: structuredClone(agent),
        artifact: null,
        outcome: 'running',
      };
      task.evidence = [];
      task.phase = 'running';
      this.event(task, 'attempt.started', { ...task.attempt, ...(task.slice ? { sliceIndex: task.slice.index } : {}) });
      return structuredClone(task.attempt);
    });
  }

  /**
   * Settles the running attempt. A result for any other attempt, version or phase is journaled as
   * ignored and returns false rather than throwing, because late or duplicate results are expected
   * after stops and restarts.
   */
  finish(
    id: string,
    attemptId: string,
    version: number,
    outcome: 'succeeded' | 'failed',
    artifact: string,
    summary: string,
  ): boolean {
    nonempty(summary, 'summary');
    if (outcome !== 'succeeded' && outcome !== 'failed') throw new Error('Invalid attempt outcome');
    if (outcome === 'succeeded') nonempty(artifact, 'artifact');
    return this.change(id, task => {
      const result = { attemptId, version, outcome, artifact, summary };
      if (task.attempt?.id !== attemptId || task.version !== version || task.phase !== 'running') {
        this.event(task, 'result.ignored', { reason: 'stale, duplicate, or interrupted attempt', result });
        return false;
      }
      assertTaskExecutionIdle(this.store, id);
      task.attempt.outcome = outcome;
      task.attempt.artifact = artifact || null;
      task.phase =
        outcome === 'failed'
          ? 'failed'
          : task.decisions.some(item => !item.accepted)
            ? 'awaiting_decision'
            : 'awaiting_verification';
      this.event(task, 'attempt.finished', result);
      return true;
    });
  }

  /**
   * Records evidence for the current successful attempt and artifact. Stale or duplicate evidence is
   * journaled as ignored and returns false. Throws when the evidence could never be valid: synthetic
   * evidence on a real task, a review without an independent session, or agent-sourced validation or
   * verification.
   */
  record(id: string, evidence: Evidence): boolean {
    validateEvidenceShape(evidence);
    return this.change(id, task => {
      if (
        task.attempt?.id !== evidence.attemptId ||
        task.version !== evidence.version ||
        task.attempt.artifact !== evidence.artifact ||
        task.attempt.outcome !== 'succeeded' ||
        !['awaiting_verification', 'awaiting_decision'].includes(task.phase)
      ) {
        this.event(task, 'evidence.ignored', { reason: 'stale attempt, artifact, or state', evidence });
        return false;
      }
      assertTaskExecutionIdle(this.store, id);
      if (task.evidence.some(item => item.id === evidence.id)) {
        this.event(task, 'evidence.ignored', { reason: 'duplicate evidence id', evidence });
        return false;
      }
      if (evidence.source === 'synthetic' && !task.synthetic)
        throw new Error('Synthetic evidence cannot verify a real task');
      if (evidence.kind === 'review') this.checkReviewer(task, task.attempt.agent, evidence);
      if (evidence.kind === 'validation' || evidence.kind === 'verification') {
        if (evidence.source === 'agent')
          throw new Error('Agent claims alone cannot establish validation or verification');
      }
      task.evidence.push(structuredClone(evidence));
      this.event(task, 'evidence.recorded', evidence);
      return true;
    });
  }

  /**
   * Review evidence needs a reviewer session independent of the implementer's. The same provider is
   * allowed only with a recorded fallback reason, which is journaled so the weaker review is visible.
   */
  private checkReviewer(task: Task, implementer: Agent, evidence: Evidence): void {
    if (!evidence.agent) throw new Error('Review requires reviewer identity');
    validateAgent(evidence.agent);
    if (evidence.agent.provider === implementer.provider && evidence.agent.sessionId === implementer.sessionId) {
      throw new Error('Review must use an independent session');
    }
    if (evidence.agent.provider === implementer.provider) {
      nonempty(evidence.fallbackReason ?? '', 'same-provider fallback reason');
      this.event(task, 'review.same_provider_fallback', {
        implementer,
        reviewer: evidence.agent,
        reason: evidence.fallbackReason,
      });
    }
  }

  /** Proposes a provisional decision; returns its id. A finished attempt then waits for its acceptance. */
  addDecision(id: string, rationale: string): string {
    nonempty(rationale, 'rationale');
    return this.change(id, task => {
      if (task.phase === 'complete') throw new Error('Revise a completed task before changing its decisions');
      const decision = { id: randomUUID(), version: task.version, rationale, accepted: false };
      task.decisions.push(decision);
      if (task.phase === 'awaiting_verification') task.phase = 'awaiting_decision';
      this.event(task, 'decision.proposed', decision);
      return decision.id;
    });
  }

  /**
   * Accepts one pending decision; `version` must be the task's current version, so acceptance never
   * covers a revision the caller has not seen. Once none is pending, a task awaiting a
   * decision moves on to awaiting verification. Throws on a version conflict or an unknown or already
   * accepted decision.
   */
  acceptDecision(id: string, decisionId: string, version: number): void {
    this.change(id, task => {
      if (version !== task.version) throw new Error('Version conflict');
      const decision = task.decisions.find(item => item.id === decisionId);
      if (!decision || decision.accepted) throw new Error('Pending decision not found');
      decision.accepted = true;
      if (task.phase === 'awaiting_decision' && task.decisions.every(item => item.accepted))
        task.phase = 'awaiting_verification';
      this.event(task, 'decision.accepted', { decisionId, version });
    });
  }

  /** Persists a stop request; the attempt stays unsettled until {@link confirmStopped} proves the exit. */
  requestStop(id: string): void {
    this.change(id, task => {
      if (task.phase !== 'running') throw new Error('No running attempt to stop');
      task.phase = 'stop_requested';
      this.event(task, 'stop.requested', { attemptId: currentAttempt(task).id });
    });
  }

  /** Settles a stop once `evidence` (a confirmed process exit) shows nothing is still running. */
  confirmStopped(id: string, attemptId: string, evidence: string): void {
    nonempty(evidence, 'stop confirmation');
    this.change(id, task => {
      if (!['stop_requested', 'recovery_required'].includes(task.phase) || task.attempt?.id !== attemptId) {
        throw new Error('No matching attempt awaiting stop confirmation');
      }
      assertTaskExecutionIdle(this.store, id);
      task.attempt.outcome = 'stopped';
      task.phase = 'stopped';
      this.event(task, 'stop.confirmed', { attemptId, evidence });
    });
  }

  /**
   * Marks every running or stopping task as requiring recovery with an `uncertain` attempt, because a
   * process may still be working. Call only after establishing the previous controller no longer owns
   * these tasks. Returns the recovered task ids. All tasks change in one transaction: if any of them
   * still has a workspace lease, it throws and none is marked.
   */
  recover(): string[] {
    return this.store.transaction(() => {
      const recovered: string[] = [];
      for (const task of this.list()) {
        if (!['running', 'stop_requested'].includes(task.phase)) continue;
        assertTaskExecutionIdle(this.store, task.id);
        const attempt = currentAttempt(task);
        task.phase = 'recovery_required';
        attempt.outcome = 'uncertain';
        this.event(task, 'recovery.required', {
          attemptId: attempt.id,
          reason: 'Previous execution must be reconciled; process liveness unknown',
        });
        this.store.save(task.id, task);
        recovered.push(task.id);
      }
      return recovered;
    });
  }

  /**
   * Why the current slice cannot be delivered yet, as human-readable reasons; empty when it can. Each
   * gate reads only the latest evidence of its kind (or lens), so an older pass never hides a newer
   * failure.
   */
  sliceBlockers(id: string): string[] {
    const task = this.get(id);
    const reasons: string[] = [];
    if (this.store.workspaces().some(workspace => workspace.taskId === id && this.store.lease(workspace.id))) {
      reasons.push('Workspace execution is active or needs recovery');
    }
    if (task.approvedVersion !== task.version) reasons.push('Current plan is not approved');
    if (
      !['awaiting_verification', 'awaiting_decision', 'complete'].includes(task.phase) ||
      task.attempt?.outcome !== 'succeeded'
    )
      reasons.push('Implementation has not finished successfully');
    for (const pass of requiredQualityLenses(task)) {
      const evidence = task.evidence.findLast(item => item.kind === 'quality' && item.pass === pass);
      if (evidence?.outcome !== 'passed') reasons.push(`${pass} assessment has not passed`);
    }
    for (const kind of ['validation', 'review', 'verification'] as const) {
      const evidence = task.evidence.findLast(item => item.kind === kind);
      if (evidence?.outcome !== 'passed') reasons.push(`${kind} has not passed`);
      if (
        kind === 'verification' &&
        evidence?.outcome === 'passed' &&
        !activeCriteria(task).every(criterion => evidence.criteria?.includes(criterion))
      ) {
        reasons.push('Verification does not cover all acceptance criteria');
      }
    }
    if (task.decisions.some(item => !item.accepted)) reasons.push('Provisional decisions need acceptance');
    return reasons;
  }

  /** {@link sliceBlockers}, plus undelivered slices: what still prevents completing the whole task. */
  blockers(id: string): string[] {
    const task = this.get(id);
    const reasons = this.sliceBlockers(id);
    if (task.slice && task.slice.completed.length !== plannedSlices(task).length)
      reasons.push('Planned slices have not all been delivered');
    return reasons;
  }

  /**
   * Records a verified delivery of the current slice and advances to the next one (or completes the
   * task after the final slice). Called only after supervised delivery verification, in the
   * settlement transaction. Throws unless the delivery is exactly the current attempt's artifact for
   * the next undelivered slice.
   */
  acceptDelivery(id: string, deliveryId: string): void {
    if (!this.get(id).slice) {
      this.complete(id);
      return;
    }
    this.change(id, task => {
      const delivery = this.store.delivery(deliveryId);
      const execution = this.store.execution(delivery.executionId);
      const reasons = this.sliceBlockers(id);
      if (reasons.length) throw new Error(`Cannot deliver slice: ${reasons.join('; ')}`);
      const completed = deliveredSlice(task, delivery, execution);
      const progress = completed.progress;
      progress.completed.push(completed.record);
      this.event(task, 'slice.delivered', completed.record);
      if (progress.index === plannedSlices(task).length - 1) {
        task.phase = 'complete';
        this.event(task, 'task.completed', {
          attemptId: completed.record.attemptId,
          artifact: completed.record.artifact,
          synthetic: task.synthetic,
        });
      } else {
        progress.index++;
        task.attempt = null;
        task.evidence = [];
        task.phase = 'ready';
        this.event(task, 'slice.ready', { index: progress.index, title: plannedSlice(task, progress.index).title });
      }
    });
  }

  /** Completes the task once {@link blockers} is empty; throws with the reasons otherwise. */
  complete(id: string): void {
    this.change(id, task => {
      if (task.phase === 'complete') throw new Error('Task is already complete');
      const reasons = this.blockers(id);
      if (reasons.length) throw new Error(`Cannot complete: ${reasons.join('; ')}`);
      const attempt = currentAttempt(task);
      task.phase = 'complete';
      this.event(task, 'task.completed', {
        attemptId: attempt.id,
        artifact: attempt.artifact,
        synthetic: task.synthetic,
      });
    });
  }
}
