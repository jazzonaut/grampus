import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { Store } from './store.js';
import { Workflow, activeCriteria, type Task } from './workflow.js';
import { Workspaces } from './workspaces.js';
import { Executions } from './executions.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import { Sessions, runSession } from './sessions.js';
import { Implementations, type ImplementationRun } from './implementations.js';
import { Checks, type RepositoryCheck, type SimplificationAssessment } from './checks.js';
import { Deliveries, type Delivery } from './deliveries.js';
import { processAlive } from './check-recovery.js';
import { currentProcessStartedAt } from './process-identity.js';
import { prepareEditing, type EditPolicy } from './edit-policy.js';
import { boundedRepositoryFiles } from './repository-evidence.js';
import type { RepositorySnapshot } from './artifacts.js';
import type { Connector } from './agents/types.js';
import { guidedPlanDigest, normalizeGuidedPlan, type GuidedPlan } from './guided-plan.js';
import type { CheckProcessOptions, CheckProcessResult } from './check-process.js';

type Stage = 'workspace' | 'execution' | 'scope' | 'implementation' | 'validation' | 'submission' | 'assessment' | 'review_execution' | 'review' | 'verification' | 'delivery' | 'complete';
type Status = 'draft' | 'ready' | 'running' | 'awaiting_scope' | 'awaiting_assessment' | 'awaiting_answer' | 'blocked' | 'recovery_required' | 'complete';
interface Owner { token: string; controllerPid: number; controllerStartedAt: string | null; host: string }
interface Pending { stage: Stage; known: string[]; assessment: SimplificationAssessment | null; controller: Owner }
export interface GuidedState {
  version: number; plan: GuidedPlan; digest: string; approvedDigest: string | null;
  status: Status; stage: Stage; sliceIndex: number;
  workspaceId: string | null; executionId: string | null; reviewId: string | null; validationId: string | null;
  snapshot: RepositorySnapshot | null; policy: EditPolicy | null;
  owner: Owner | null; pending: Pending | null; stopRequested: boolean;
  assessment: SimplificationAssessment | null;
  answers: Record<string, string> | null; feedback: string; note: string;
}
export interface GuidedServices {
  expectedState?: string;
  workspaces?: Workspaces;
  implementationRunner?: (options: CheckProcessOptions) => Promise<CheckProcessResult>;
  connector?: Connector;
}
export function guidedQuestionKey(store: Store, state: GuidedState): string | null {
  if (state.status !== 'awaiting_answer') return null;
  const execution = store.execution<Execution>((state.stage === 'review' ? state.reviewId : state.executionId)!);
  const session = new Sessions(store).get(execution.sessionId);
  const turn = store.sessionEvents(session.id).findLast(event => event.type === 'turn.requested');
  return createHash('sha256').update(JSON.stringify({ sessionId: session.id, turn, questions: session.lastReply?.questions })).digest('hex');
}
export function guidedDecisionKey(state: GuidedState, questionKey: string | null = null): string {
  return JSON.stringify({ version: state.version, digest: state.digest, status: state.status, stage: state.stage,
    artifact: state.snapshot?.artifact ?? null, instructionsDigest: state.snapshot?.instructionsDigest ?? null,
    executionId: state.executionId, reviewId: state.reviewId, questionKey });
}

/** Sequential, explicit continuation over the existing controller; no provider/Git replay. */
export class GuidedTasks {
  private readonly workflow: Workflow;
  private readonly workspaces: Workspaces;
  private readonly executions: Executions;
  private readonly checks: Checks;
  constructor(private readonly store: Store, private readonly services: GuidedServices = {}) {
    this.workflow = new Workflow(store); this.workspaces = services.workspaces ?? new Workspaces(store);
    this.executions = new Executions(store, this.workspaces); this.checks = new Checks(store, this.workspaces);
  }
  get(id: string): GuidedState {
    const state = this.workflow.get(id).guided;
    if (!state) throw new Error('This task has no guided plan');
    return state;
  }
  create(input: unknown, directory?: string): Task {
    if (this.store.path === ':memory:') throw new Error('Guided tasks require a durable journal');
    const plan = normalizeGuidedPlan(input, directory);
    return this.store.transaction(() => {
      const task = this.workflow.create(plan.brief);
      task.guided = { version: task.version, plan, digest: guidedPlanDigest(plan), approvedDigest: null,
        status: 'draft', stage: 'workspace', sliceIndex: 0, workspaceId: null, executionId: null, reviewId: null, validationId: null,
        snapshot: null, policy: null, owner: null, pending: null, stopRequested: false, assessment: null, answers: null, feedback: '',
        note: 'Inspect the brief, selected files, commands, expected output and pinned base before approving.' };
      this.store.save(task.id, task); this.store.append(task.id, task.version, 'guided.created', { digest: task.guided.digest, plan });
      return task;
    });
  }
  private current(id: string, approved = true): GuidedState {
    const task = this.workflow.get(id), state = this.get(id);
    if (task.version !== state.version || JSON.stringify(task.brief) !== JSON.stringify(state.plan.brief)
      || guidedPlanDigest(state.plan) !== state.digest) throw new Error('The guided plan is stale or changed; inspect the task through the ordinary CLI');
    if (approved && (task.approvedVersion !== state.version || state.approvedDigest !== state.digest)) throw new Error('Approve the exact guided plan with task-approve first');
    return state;
  }
  private change(id: string, token: string | null, type: string, update: (state: GuidedState) => void): GuidedState {
    return this.store.transaction(() => {
      const task = this.workflow.get(id), state = task.guided;
      if (!state || (token !== null && state.owner?.token !== token)) throw new Error('Guided controller ownership changed');
      update(state); this.store.save(id, task);
      this.store.append(id, task.version, type, { status: state.status, stage: state.stage, sliceIndex: state.sliceIndex,
        workspaceId: state.workspaceId, executionId: state.executionId, reviewId: state.reviewId, pending: state.pending, note: state.note,
        digest: state.digest, approvedDigest: state.approvedDigest, owner: state.owner, stopRequested: state.stopRequested,
        artifact: state.snapshot?.artifact ?? null, instructionsDigest: state.snapshot?.instructionsDigest ?? null,
        policy: state.policy, assessment: state.assessment });
      return state;
    });
  }
  approve(id: string, version: number, digest: string): GuidedState {
    return this.store.transaction(() => {
      const state = this.current(id, false);
      this.requireExpected(state);
      if (state.owner || state.status !== 'draft' || version !== state.version || digest !== state.digest) throw new Error('Approval must name the current draft version and guided plan digest');
      this.workflow.approve(id, version);
      return this.change(id, null, 'guided.approved', state => {
        state.approvedDigest = digest; state.status = 'ready'; state.note = 'Run the task to prepare its workspace and inspect the exact file authorization.';
      });
    });
  }
  private take(id: string, recover = false, expected?: Status | Status[]): string {
    return this.store.transaction(() => {
      if (!recover) this.current(id);
      const state = this.get(id);
      this.requireExpected(state);
      if (expected && !(Array.isArray(expected) ? expected : [expected]).includes(state.status)) throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
      for (const task of this.workflow.list()) if (task.id !== id && task.guided?.owner) throw new Error(`Another guided task owns the runner: ${task.id}. Inspect or recover it first.`);
      if (state.owner) {
        if (!recover) throw new Error('This task has an active or uncertain guided controller; use task-recover after it exits');
        if (state.owner.host !== hostname() || processAlive(state.owner.controllerPid, state.owner.controllerStartedAt)) throw new Error('Previous guided controller is still alive, on another host or unverifiable');
      }
      const token = randomUUID();
      this.change(id, null, 'guided.controller_claimed', state => {
        state.owner = { token, controllerPid: process.pid, controllerStartedAt: currentProcessStartedAt(), host: hostname() };
        state.stopRequested = false;
      });
      return token;
    });
  }
  private requireExpected(state: GuidedState): void {
    if (this.services.expectedState !== undefined && this.services.expectedState !== guidedDecisionKey(state, guidedQuestionKey(this.store, state))) throw new Error('Task changed since you inspected it; refresh before taking this action');
  }
  private unsettled(id: string, state: GuidedState): boolean {
    if (state.workspaceId && this.store.lease(state.workspaceId)) return true;
    const workspace = this.workspaces.list().find(item => item.taskId === id);
    return !!workspace && workspace.phase !== 'ready';
  }
  private leave(id: string, token: string): void {
    this.change(id, token, 'guided.controller_checkpoint', state => {
      if (state.pending || this.unsettled(id, state)) {
        state.status = 'recovery_required'; state.note ||= 'Inspect settlement proof and run task-recover after this controller exits.';
      } else state.owner = null;
    });
  }
  stop(id: string): GuidedState {
    return this.change(id, null, 'guided.stop_requested', state => {
      if (!state.owner) throw new Error('No guided controller is running');
      state.stopRequested = true; state.note = 'Stop requested; waiting for confirmed process settlement.';
    });
  }
  private ids(id: string, state: GuidedState): string[] {
    switch (state.stage) {
      case 'workspace': return this.workspaces.list().filter(item => item.taskId === id).map(item => item.id);
      case 'execution': case 'review_execution': return this.executions.list().filter(item => item.taskId === id).map(item => item.id);
      case 'implementation': return this.store.implementations<ImplementationRun>(state.executionId!).map(item => item.id);
      case 'validation': case 'verification': return this.store.checks<RepositoryCheck>(state.executionId!).map(item => item.id);
      case 'delivery': return this.store.deliveries<Delivery>(state.executionId!).map(item => item.id);
      case 'review': return this.store.sessionEvents(this.executions.get(state.reviewId!).sessionId).filter(event => event.type === 'turn.requested').map(event => (event.data as { runId: string }).runId);
      default: return this.workflow.get(id).evidence.map(item => item.id);
    }
  }
  private begin(id: string, token: string): GuidedState {
    const state = this.current(id);
    if (state.pending) throw new Error('An earlier step needs explicit recovery; nothing will be replayed');
    const known = this.ids(id, state);
    return this.change(id, token, 'guided.step_requested', state => {
      state.pending = { stage: state.stage, known, assessment: state.assessment, controller: { ...state.owner! } }; state.status = 'running'; state.note = `Running ${state.stage}.`;
    });
  }
  private policy(state: GuidedState, snapshot: RepositorySnapshot): EditPolicy {
    const scope = state.plan.slices[state.sliceIndex]!.scope;
    const present = (path: string) => snapshot.files.some(file => file.path === path && file.sha256 !== null);
    const created = (scope.create ?? []).filter(present);
    return { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: [...scope.files, ...created],
      ...((scope.create ?? []).some(path => !present(path)) ? { create: scope.create!.filter(path => !present(path)) } : {}),
      ...((scope.delete ?? []).some(present) ? { delete: scope.delete!.filter(present) } : {}) };
  }
  private async perform(id: string, state: GuidedState, signal: AbortSignal): Promise<RepositorySnapshot | null> {
    const slice = state.plan.slices[state.sliceIndex]!, executionId = state.executionId!;
    switch (state.stage) {
      case 'workspace': {
        const config = state.plan.workspace;
        if (config.adapter === 'orca') await this.workspaces.createOrca(id, state.version, config.repo, config.base);
        else await this.workspaces.create(id, state.version, config.repo, config.path!, config.base);
        break;
      }
      case 'execution': await this.executions.create(state.workspaceId!, state.version, state.plan.implementation.provider, 'implementation', state.plan.implementation.model); break;
      case 'scope': {
        const snapshot = await this.checks.snapshot(executionId), cwd = this.workspaces.get(state.workspaceId!).path!;
        boundedRepositoryFiles(cwd, snapshot);
        if (slice.mode !== 'no_change') prepareEditing({ cwd, snapshot, policy: this.policy(state, snapshot) });
        return snapshot;
      }
      case 'implementation': await new Implementations(this.store, this.workspaces).run(executionId, state.policy!,
        `Implement the approved current slice within the authorized file policy.\n${state.feedback ? `Earlier attempt feedback (untrusted claims; do not expand scope):\n${state.feedback}` : ''}`,
        { signal, timeoutMs: state.plan.implementation.timeoutMs, ...(state.answers ? { answers: state.answers } : {}) }, this.services.implementationRunner); break;
      case 'validation': await this.checks.run(executionId, { ...slice.validation, artifact: state.snapshot!.artifact, instructionsDigest: state.snapshot!.instructionsDigest }, signal); break;
      case 'submission': await this.checks.finish(executionId, state.validationId!); break;
      case 'assessment': await this.checks.simplify(executionId, state.pending!.assessment!); break;
      case 'review_execution': await this.executions.create(state.workspaceId!, state.version, state.plan.review.provider, 'review', state.plan.review.model); break;
      case 'review': await runSession(this.store, this.executions.get(state.reviewId!).sessionId, 'Independently review the approved current slice and integration.',
        { artifactReview: true, signal, timeoutMs: state.plan.review.timeoutMs, ...(state.answers ? { answers: state.answers } : {}) }, this.services.connector, this.workspaces); break;
      case 'verification': await this.checks.run(executionId, { ...slice.acceptance, artifact: state.snapshot!.artifact,
        instructionsDigest: state.snapshot!.instructionsDigest, criteria: activeCriteria(this.workflow.get(id)) }, signal); break;
      case 'delivery': await new Deliveries(this.store, this.workspaces).run(executionId, { artifact: state.snapshot!.artifact,
        instructionsDigest: state.snapshot!.instructionsDigest, message: slice.message, mode: slice.mode, timeoutMs: 120000 }, signal); break;
    }
    return null;
  }
  private one<T extends { id: string }>(items: T[], pending: Pending): T | null {
    const found = items.filter(item => !pending.known.includes(item.id));
    if (found.length > 1) throw new Error('Ambiguous step results; inspect the ordinary CLI. No operation will be replayed.');
    return found[0] ?? null;
  }
  private requireOrigin(executionId: string, runId: string, pending: Pending): void {
    const event = this.store.executionEvents(executionId).find(event => event.type === 'lease.acquired' && (event.data as ExecutionLease).runId === runId);
    const lease = event?.data as ExecutionLease | undefined;
    if (!lease || lease.controllerPid !== pending.controller.controllerPid || lease.controllerStartedAt !== pending.controller.controllerStartedAt
      || lease.host !== pending.controller.host) throw new Error('Step result belongs to a different controller; inspect it through the ordinary CLI');
  }
  private settle(id: string, token: string, snapshot: RepositorySnapshot | null = null, recovering = false): void {
    const state = this.get(id), pending = state.pending!;
    const block = (note: string) => this.change(id, token, 'guided.blocked', state => { state.pending = null; state.status = 'blocked'; state.note = note; });
    const advance = (stage: Stage, update: (state: GuidedState) => void = () => {}) => this.change(id, token, recovering ? 'guided.step_reconciled' : 'guided.step_finished', state => {
      state.pending = null; state.stage = stage; state.status = stage === 'complete' ? 'complete' : 'ready'; state.note = ''; update(state);
    });
    const missing = () => {
      if (!recovering) throw new Error('The operation returned without a durable result');
      advance(pending.stage); // Explicit recovery proves no leaf dispatch; the next task-run remains explicit.
    };
    switch (pending.stage) {
      case 'workspace': {
        const result = this.one(this.workspaces.list().filter(item => item.taskId === id), pending);
        if (!result) { missing(); break; }
        if (result.phase !== 'ready') throw new Error(`Workspace needs recovery: ${result.id}`);
        const config = state.plan.workspace;
        if (result.version !== state.version || result.adapter !== config.adapter || result.repository !== config.repo || result.baseCommit !== config.base
          || config.adapter === 'git' && result.path !== config.path) throw new Error('Workspace result differs from the approved guided plan');
        advance('execution', state => { state.workspaceId = result.id; }); break;
      }
      case 'execution': case 'review_execution': {
        const role = pending.stage === 'execution' ? 'implementation' : 'review';
        const result = this.one(this.executions.list().filter(item => item.taskId === id && item.role === role), pending);
        if (!result) { missing(); break; }
        if (result.version !== state.version || result.workspaceId !== state.workspaceId || result.attemptId !== this.workflow.get(id).attempt?.id) throw new Error('Execution result no longer matches the guided task');
        const session = new Sessions(this.store).get(result.sessionId), config = role === 'implementation' ? state.plan.implementation : state.plan.review;
        if (session.provider !== config.provider || config.model !== null && session.model !== config.model
          || this.store.sessionEvents(session.id).some(event => event.type === 'turn.requested')) throw new Error('New execution was changed or used outside this guided step');
        advance(role === 'implementation' ? 'scope' : 'review', state => { if (role === 'implementation') state.executionId = result.id; else state.reviewId = result.id; }); break;
      }
      case 'scope': {
        if (!snapshot) { missing(); break; }
        advance('scope', state => { state.snapshot = snapshot; state.policy = state.plan.slices[state.sliceIndex]!.mode === 'no_change' ? null : this.policy(state, snapshot);
          state.status = 'awaiting_scope'; state.note = 'Inspect the workspace, repository instructions and exact file scope, then use task-authorize.'; }); break;
      }
      case 'implementation': {
        const result = this.one(this.store.implementations<ImplementationRun>(state.executionId!), pending);
        if (!result) { missing(); break; }
        this.requireOrigin(state.executionId!, result.id, pending);
        if (JSON.stringify(result.policy) !== JSON.stringify(state.policy)) throw new Error('Implementation result differs from the authorized file policy');
        if (result.phase === 'running' || result.phase === 'recovery_required') throw new Error(`Implementation needs recovery: ${result.id}`);
        if (result.phase !== 'completed' || !result.after) { block(result.error ?? result.result?.error ?? `Implementation ${result.phase}; inspect partial files and use task-retry.`); break; }
        boundedRepositoryFiles(this.workspaces.get(state.workspaceId!).path!, result.after);
        advance(result.result?.reply?.kind === 'question' ? 'implementation' : 'validation', state => {
          state.answers = null; state.snapshot = result.after;
          if (result.result?.reply?.kind === 'question') { state.status = 'awaiting_answer'; state.note = 'Answer the implementation questions with task-answer.'; }
        }); break;
      }
      case 'validation': case 'verification': {
        const result = this.one(this.store.checks<RepositoryCheck>(state.executionId!), pending);
        if (!result) { missing(); break; }
        this.requireOrigin(state.executionId!, result.id, pending);
        const slice = state.plan.slices[state.sliceIndex]!;
        const expected = pending.stage === 'validation'
          ? { ...slice.validation, artifact: state.snapshot!.artifact, instructionsDigest: state.snapshot!.instructionsDigest }
          : { ...slice.acceptance, artifact: state.snapshot!.artifact, instructionsDigest: state.snapshot!.instructionsDigest, criteria: activeCriteria(this.workflow.get(id)) };
        if (JSON.stringify(result.spec) !== JSON.stringify(expected)) throw new Error('Check result differs from the approved command or acceptance expectation');
        if (result.phase === 'running' || result.phase === 'recovery_required') throw new Error(`Check needs recovery: ${result.id}`);
        if (result.phase !== 'passed') { block(`Check ${result.spec.name} ${result.phase} (${result.result?.reason ?? 'no result'}, exit ${result.result?.exitCode ?? 'unknown'}): ${result.error ?? result.result?.stderr ?? ''}. Inspect check-show ${result.id}, then task-retry.`); break; }
        advance(pending.stage === 'validation' ? 'submission' : 'delivery', state => { if (pending.stage === 'validation') state.validationId = result.id; }); break;
      }
      case 'submission': {
        const task = this.workflow.get(id);
        if (task.attempt?.artifact !== state.snapshot?.artifact || task.attempt?.outcome !== 'succeeded') { if (recovering) { missing(); break; } throw new Error('Implementation submission did not settle'); }
        advance('assessment', state => { state.status = 'awaiting_assessment'; state.assessment = null; state.note = 'Inspect the implementation and validation output. Record an explicit simplification outcome with task-assess.'; }); break;
      }
      case 'assessment': {
        const result = this.one(this.workflow.get(id).evidence.filter(item => item.kind === 'simplification' && !item.id.endsWith(':requested')), pending);
        if (!result) { advance('assessment', state => { state.status = 'awaiting_assessment'; state.assessment = null; state.note = 'No settled assessment was accepted. Inspect and submit it explicitly again.'; }); break; }
        this.requireOrigin(state.executionId!, result.id, pending);
        if (result.artifact !== pending.assessment?.artifact || result.summary !== pending.assessment.summary || result.outcome !== pending.assessment.outcome) throw new Error('Assessment differs from the explicit supplied outcome');
        if (result.outcome !== 'passed') { block(`Simplification ${result.outcome}; inspect the code and use task-retry for changes.`); break; }
        advance('review_execution', state => { state.assessment = null; }); break;
      }
      case 'review': {
        const execution = this.executions.get(state.reviewId!), session = new Sessions(this.store).get(execution.sessionId);
        const turns = this.store.sessionEvents(session.id).filter(event => event.type === 'turn.requested')
          .map(event => ({ id: (event.data as { runId: string }).runId }));
        const turn = this.one(turns, pending);
        if (!turn) { missing(); break; }
        this.requireOrigin(execution.id, turn.id, pending);
        if (session.run) throw new Error(`Review session needs recovery: ${session.id}`);
        if (session.phase === 'awaiting_answer') { advance('review', state => { state.status = 'awaiting_answer'; state.answers = null; state.note = 'Answer the reviewer questions with task-answer.'; }); break; }
        const evidence = this.workflow.get(id).evidence.find(item => item.kind === 'review' && item.id === turn.id);
        if (session.phase !== 'idle' || evidence?.outcome !== 'passed') {
          block(session.lastReply?.text || 'No independent passing review. Inspect the findings, then use task-retry.'); break;
        }
        advance('verification', state => { state.answers = null; }); break;
      }
      case 'delivery': {
        const result = this.one(this.store.deliveries<Delivery>(state.executionId!), pending);
        if (!result) { missing(); break; }
        this.requireOrigin(state.executionId!, result.id, pending);
        const slice = state.plan.slices[state.sliceIndex]!;
        if (JSON.stringify(result.spec) !== JSON.stringify({ artifact: state.snapshot!.artifact, instructionsDigest: state.snapshot!.instructionsDigest,
          message: slice.message, mode: slice.mode, timeoutMs: 120000 })) throw new Error('Delivery result differs from the approved artifact or delivery request');
        if (result.phase === 'running' || result.phase === 'recovery_required') throw new Error(`Delivery needs recovery: ${result.id}`);
        if (result.phase !== 'delivered') { block(`Delivery ${result.phase}: ${result.error ?? ''}. Inspect retained HEAD/index/files before task-retry.`); break; }
        const task = this.workflow.get(id);
        if (task.phase === 'complete') advance('complete', state => { state.note = 'Task delivered locally. The journal-derived report is available with report.'; });
        else if (task.phase === 'ready' && task.slice?.index === state.sliceIndex + 1) advance('execution', state => {
          state.sliceIndex++; state.executionId = null; state.reviewId = null; state.validationId = null; state.snapshot = null; state.policy = null; state.assessment = null; state.feedback = '';
        });
        else throw new Error('Delivered result did not advance the approved task');
        break;
      }
    }
  }
  private async drive(id: string, token: string, signal: AbortSignal): Promise<GuidedState> {
    while (this.get(id).status === 'ready') {
      if (signal.aborted) { this.change(id, token, 'guided.stopped_between_steps', state => { state.note = 'Stopped between operations. Use task-run to continue explicitly.'; }); break; }
      let operationReturned = false;
      try {
        const state = this.begin(id, token), snapshot = await this.perform(id, state, signal);
        operationReturned = true;
        this.settle(id, token, snapshot);
      } catch (error) {
        this.change(id, token, 'guided.step_failed', state => {
          state.note = error instanceof Error ? error.message : String(error);
          const recorded = state.pending && this.ids(id, state).some(value => !state.pending!.known.includes(value));
          if (state.pending && (operationReturned || recorded || this.unsettled(id, state))) state.status = 'recovery_required';
          else { state.status = 'blocked'; state.pending = null; }
        });
        break;
      }
    }
    return this.get(id);
  }
  private async owned(id: string, action: (token: string, signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal, recover = false, expected?: Status | Status[]): Promise<GuidedState> {
    const token = this.take(id, recover, expected), abort = new AbortController();
    const timer = setInterval(() => { try { if (this.get(id).stopRequested) abort.abort(); } catch { abort.abort(); } }, 250);
    try { await action(token, signal ? AbortSignal.any([signal, abort.signal]) : abort.signal); }
    finally { clearInterval(timer); this.leave(id, token); }
    return this.get(id);
  }
  async run(id: string, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'ready') throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
    return this.owned(id, (token, signal) => this.drive(id, token, signal), signal, false, 'ready');
  }
  async authorize(id: string, signal?: AbortSignal): Promise<GuidedState> {
    if (this.current(id).status !== 'awaiting_scope') throw new Error('No file authorization is pending');
    return this.owned(id, async (token, signal) => {
      this.change(id, token, 'guided.scope_authorized', state => { state.stage = state.plan.slices[state.sliceIndex]!.mode === 'no_change' ? 'validation' : 'implementation'; state.status = 'ready'; });
      await this.drive(id, token, signal);
    }, signal, false, 'awaiting_scope');
  }
  async assess(id: string, outcome: SimplificationAssessment['outcome'], summary: string, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'awaiting_assessment' || !state.snapshot) throw new Error('No simplification assessment is pending');
    if (!['passed', 'failed', 'skipped'].includes(outcome) || typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 16000) throw new Error('Choose passed/failed/skipped and supply a concrete summary (at most 16000 bytes)');
    return this.owned(id, async (token, signal) => {
      this.change(id, token, 'guided.assessment_supplied', state => {
        state.assessment = { artifact: state.snapshot!.artifact, instructionsDigest: state.snapshot!.instructionsDigest, outcome, summary }; state.status = 'ready';
      });
      await this.drive(id, token, signal);
    }, signal, false, 'awaiting_assessment');
  }
  async answer(id: string, answers: Record<string, string>, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'awaiting_answer') throw new Error('No guided questions are pending');
    const execution = this.executions.get(state.stage === 'review' ? state.reviewId! : state.executionId!);
    const questions = new Sessions(this.store).get(execution.sessionId).lastReply!.questions;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questions.length
      || questions.some(question => typeof answers[question.id] !== 'string' || !answers[question.id]!.trim())) throw new Error('Answer every pending question by id');
    return this.owned(id, async (token, signal) => {
      this.change(id, token, 'guided.answers_supplied', state => { state.answers = structuredClone(answers); state.status = 'ready'; if (state.stage === 'implementation') state.stage = 'scope'; });
      await this.drive(id, token, signal);
    }, signal, false, 'awaiting_answer');
  }
  async retry(id: string, signal?: AbortSignal): Promise<GuidedState> {
    const allowed: Status[] = ['blocked', 'awaiting_scope', 'awaiting_assessment'];
    if (!allowed.includes(this.current(id).status)) throw new Error('Retry requires a settled checkpoint or failure; recover uncertain work first');
    return this.owned(id, async (token, signal) => {
      const state = this.get(id);
      if (state.pending || this.unsettled(id, state)) throw new Error('Recover the unfinished operation before retrying');
      const feedback = { reason: state.note, review: state.reviewId ? new Sessions(this.store).get(this.executions.get(state.reviewId).sessionId).lastReply : null };
      if (state.reviewId && this.executions.get(state.reviewId).phase !== 'closed') this.executions.close(state.reviewId);
      if (state.executionId && this.executions.get(state.executionId).phase !== 'closed') this.executions.close(state.executionId);
      this.change(id, token, 'guided.retry_requested', state => {
        state.feedback = JSON.stringify(feedback).slice(0, 16000); state.stage = state.workspaceId ? 'execution' : 'workspace'; state.status = 'ready';
        state.executionId = null; state.reviewId = null; state.validationId = null; state.snapshot = null; state.policy = null; state.assessment = null; state.answers = null;
      });
      await this.drive(id, token, signal);
    }, signal, false, allowed);
  }
  async recover(id: string): Promise<GuidedState> {
    const previous = this.get(id);
    if (!previous.owner && !previous.pending && previous.status !== 'recovery_required') throw new Error('No guided recovery is needed');
    return this.owned(id, async token => {
      try {
        const state = this.get(id), workspace = this.workspaces.list().find(item => item.taskId === id);
        if (workspace && workspace.phase !== 'ready') await this.workspaces.recover(workspace.id);
        const lease = workspace ? this.store.lease<ExecutionLease>(workspace.id) : null;
        if (lease) {
          if (lease.kind === 'implementation') await new Implementations(this.store, this.workspaces).recover(lease.runId);
          else if (lease.kind === 'delivery') await new Deliveries(this.store, this.workspaces).recover(lease.runId);
          else if (lease.kind === 'check' || lease.kind === 'verification') this.checks.recover(lease.runId);
          else if (lease.readOnlyRecovery) this.executions.recoverReadOnly(lease.executionId);
          else new Sessions(this.store).recover(lease.sessionId);
        }
        if (state.pending) this.settle(id, token, null, true);
        else this.change(id, token, 'guided.controller_reconciled', state => { if (state.status === 'running' || state.status === 'recovery_required') state.status = 'ready'; });
      } catch (error) {
        this.change(id, token, 'guided.recovery_blocked', state => { state.status = 'recovery_required'; state.note = error instanceof Error ? error.message : String(error); });
      }
    }, undefined, true);
  }
}
