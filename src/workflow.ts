import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type { Workspace } from './workspaces.js';
import { assertTaskExecutionIdle } from './execution-state.js';

export interface Brief {
  title: string;
  outcome: string;
  criteria: string[];
  plan: string;
}

export interface Agent {
  provider: string;
  model: string;
  sessionId: string;
}

export interface Attempt {
  id: string;
  version: number;
  agent: Agent;
  artifact: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'stopped' | 'uncertain';
}

export interface Evidence {
  id: string;
  attemptId: string;
  version: number;
  artifact: string;
  kind: 'simplification' | 'validation' | 'review' | 'verification';
  outcome: 'passed' | 'failed' | 'skipped';
  summary: string;
  source: 'controller' | 'agent' | 'synthetic';
  agent?: Agent;
  criteria?: string[];
  fallbackReason?: string;
}

export type Phase = 'draft' | 'ready' | 'running' | 'stop_requested' | 'recovery_required'
  | 'stopped' | 'failed' | 'awaiting_verification' | 'awaiting_decision' | 'complete';

export interface Task {
  id: string;
  brief: Brief;
  version: number;
  approvedVersion: number | null;
  phase: Phase;
  synthetic: boolean;
  attempt: Attempt | null;
  evidence: Evidence[];
  decisions: { id: string; version: number; rationale: string; accepted: boolean }[];
}

function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must not be empty`);
}

function validateBrief(brief: Brief): void {
  nonempty(brief.title, 'title');
  nonempty(brief.outcome, 'outcome');
  nonempty(brief.plan, 'plan');
  if (!Array.isArray(brief.criteria) || brief.criteria.length === 0) throw new Error('Acceptance criteria required');
  brief.criteria.forEach(value => nonempty(value, 'criterion'));
  if (new Set(brief.criteria).size !== brief.criteria.length) throw new Error('Acceptance criteria must be distinct');
}

function validateAgent(agent: Agent): void {
  nonempty(agent.provider, 'provider');
  nonempty(agent.model, 'model');
  nonempty(agent.sessionId, 'sessionId');
}

function unsettled(task: Task): boolean {
  return ['running', 'stop_requested', 'recovery_required'].includes(task.phase);
}

/** Trusted controller API. Provider messages must be validated before calling it. */
export class Workflow {
  constructor(private readonly store: Store) {}

  get(id: string): Task { return this.store.get<Task>(id); }
  list(): Task[] { return this.store.list<Task>(); }

  private change<T>(id: string, action: (task: Task) => T): T {
    return this.store.transaction(() => {
      const task = this.get(id);
      const result = action(task);
      this.store.save(id, task);
      return result;
    });
  }

  private event(task: Task, type: string, data: unknown): void {
    this.store.append(task.id, task.version, type, data);
  }

  private workspaceSettled(task: Task, requireCurrent = false): void {
    assertTaskExecutionIdle(this.store, task.id);
    const workspace = this.store.workspaces<Workspace>().find(item => item.taskId === task.id);
    if (!workspace) return;
    if (workspace.phase !== 'ready') throw new Error('Settle or reconcile workspace creation first');
    if (requireCurrent && workspace.version !== task.version) throw new Error('Workspace belongs to an earlier task version');
  }

  create(brief: Brief, synthetic = false): Task {
    validateBrief(brief);
    const task: Task = {
      id: randomUUID(), brief: structuredClone(brief), version: 1, approvedVersion: null,
      phase: 'draft', synthetic, attempt: null, evidence: [], decisions: [],
    };
    this.store.transaction(() => {
      this.store.save(task.id, task);
      this.event(task, 'task.created', { brief, synthetic });
    });
    return task;
  }

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
      // Pending decisions survive revisions until explicitly accepted.
      task.phase = 'draft';
      this.event(task, 'task.revised', { brief, previousVersion: expectedVersion });
    });
  }

  approve(id: string, version: number): void {
    this.change(id, task => {
      if (version !== task.version) throw new Error('Cannot approve an outdated version');
      if (task.phase !== 'draft') throw new Error('Only a draft can be approved');
      task.approvedVersion = version;
      task.phase = 'ready';
      this.event(task, 'plan.approved', { version });
    });
  }

  start(id: string, agent: Agent): Attempt {
    validateAgent(agent);
    return this.change(id, task => {
      if (task.approvedVersion !== task.version) throw new Error('Current plan needs approval');
      this.workspaceSettled(task, true);
      if (!['ready', 'stopped', 'failed', 'awaiting_verification', 'awaiting_decision'].includes(task.phase)) {
        throw new Error('Task cannot start in its current state');
      }
      task.attempt = { id: randomUUID(), version: task.version, agent: structuredClone(agent), artifact: null, outcome: 'running' };
      task.evidence = [];
      task.phase = 'running';
      this.event(task, 'attempt.started', task.attempt);
      return structuredClone(task.attempt);
    });
  }

  finish(id: string, attemptId: string, version: number, outcome: 'succeeded' | 'failed', artifact: string, summary: string): boolean {
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
      task.phase = outcome === 'failed' ? 'failed'
        : task.decisions.some(item => !item.accepted) ? 'awaiting_decision' : 'awaiting_verification';
      this.event(task, 'attempt.finished', result);
      return true;
    });
  }

  record(id: string, evidence: Evidence): boolean {
    nonempty(evidence.id, 'evidence id');
    nonempty(evidence.summary, 'summary');
    if (!['simplification', 'validation', 'review', 'verification'].includes(evidence.kind)
      || !['passed', 'failed', 'skipped'].includes(evidence.outcome)
      || !['controller', 'agent', 'synthetic'].includes(evidence.source)) throw new Error('Invalid evidence');
    return this.change(id, task => {
      if (task.attempt?.id !== evidence.attemptId || task.version !== evidence.version
        || task.attempt.artifact !== evidence.artifact || task.attempt.outcome !== 'succeeded'
        || !['awaiting_verification', 'awaiting_decision'].includes(task.phase)) {
        this.event(task, 'evidence.ignored', { reason: 'stale attempt, artifact, or state', evidence });
        return false;
      }
      assertTaskExecutionIdle(this.store, id);
      if (task.evidence.some(item => item.id === evidence.id)) {
        this.event(task, 'evidence.ignored', { reason: 'duplicate evidence id', evidence });
        return false;
      }
      if (evidence.source === 'synthetic' && !task.synthetic) throw new Error('Synthetic evidence cannot verify a real task');
      if (evidence.kind === 'review') {
        if (!evidence.agent) throw new Error('Review requires reviewer identity');
        validateAgent(evidence.agent);
        const implementer = task.attempt.agent;
        if (evidence.agent.provider === implementer.provider && evidence.agent.sessionId === implementer.sessionId) {
          throw new Error('Review must use an independent session');
        }
        if (evidence.agent.provider === implementer.provider) {
          nonempty(evidence.fallbackReason ?? '', 'same-provider fallback reason');
          this.event(task, 'review.same_provider_fallback', { implementer, reviewer: evidence.agent, reason: evidence.fallbackReason });
        }
      }
      if (evidence.kind === 'validation' || evidence.kind === 'verification') {
        if (evidence.source === 'agent') throw new Error('Agent claims alone cannot establish validation or verification');
      }
      task.evidence.push(structuredClone(evidence));
      this.event(task, 'evidence.recorded', evidence);
      return true;
    });
  }

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

  acceptDecision(id: string, decisionId: string, version: number): void {
    this.change(id, task => {
      if (version !== task.version) throw new Error('Version conflict');
      const decision = task.decisions.find(item => item.id === decisionId);
      if (!decision || decision.accepted) throw new Error('Pending decision not found');
      decision.accepted = true;
      if (task.phase === 'awaiting_decision' && task.decisions.every(item => item.accepted)) task.phase = 'awaiting_verification';
      this.event(task, 'decision.accepted', { decisionId, version });
    });
  }

  requestStop(id: string): void {
    this.change(id, task => {
      if (task.phase !== 'running') throw new Error('No running attempt to stop');
      task.phase = 'stop_requested';
      this.event(task, 'stop.requested', { attemptId: task.attempt!.id });
    });
  }

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

  /** Call only after establishing the previous controller no longer owns these tasks. */
  recover(): string[] {
    return this.store.transaction(() => {
      const recovered: string[] = [];
      for (const task of this.list()) {
        if (!['running', 'stop_requested'].includes(task.phase)) continue;
        assertTaskExecutionIdle(this.store, task.id);
        task.phase = 'recovery_required';
        task.attempt!.outcome = 'uncertain';
        this.event(task, 'recovery.required', { attemptId: task.attempt!.id, reason: 'Previous execution must be reconciled; process liveness unknown' });
        this.store.save(task.id, task);
        recovered.push(task.id);
      }
      return recovered;
    });
  }

  blockers(id: string): string[] {
    const task = this.get(id);
    const reasons: string[] = [];
    if (this.store.workspaces<Workspace>().some(workspace => workspace.taskId === id && this.store.lease(workspace.id))) {
      reasons.push('Workspace execution is active or needs recovery');
    }
    if (task.approvedVersion !== task.version) reasons.push('Current plan is not approved');
    if (!['awaiting_verification', 'awaiting_decision', 'complete'].includes(task.phase)
      || task.attempt?.outcome !== 'succeeded') reasons.push('Implementation has not finished successfully');
    for (const kind of ['simplification', 'validation', 'review', 'verification'] as const) {
      const evidence = task.evidence.findLast(item => item.kind === kind);
      if (evidence?.outcome !== 'passed') reasons.push(`${kind} has not passed`);
      if (kind === 'verification' && evidence?.outcome === 'passed'
        && !task.brief.criteria.every(criterion => evidence.criteria?.includes(criterion))) {
        reasons.push('Verification does not cover all acceptance criteria');
      }
    }
    if (task.decisions.some(item => !item.accepted)) reasons.push('Provisional decisions need acceptance');
    return reasons;
  }

  complete(id: string): void {
    this.change(id, task => {
      if (task.phase === 'complete') throw new Error('Task is already complete');
      const reasons = this.blockers(id);
      if (reasons.length) throw new Error(`Cannot complete: ${reasons.join('; ')}`);
      task.phase = 'complete';
      this.event(task, 'task.completed', { attemptId: task.attempt!.id, artifact: task.attempt!.artifact, synthetic: task.synthetic });
    });
  }
}
