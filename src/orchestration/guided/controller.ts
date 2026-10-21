// Owns the guided task controller: its public API for the CLI, dashboard and tests, claiming and releasing a
// task's runner within the bounded pool (./runner-pool.ts), the drive loop and every journaled change of guided
// state; stage dispatch and settlement live in ./stages, prompts in ./prompts.ts. It never replays a provider
// turn, command or Git write, and never takes ownership from a live or unverifiable controller.
import { requireComparisonMember } from '../../domain/comparison.js';
import { comparisonRetries } from '../../domain/comparison-retries.js';
import { Comparisons } from '../comparisons.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Store } from '../../persistence/store.js';
import { planLimits, processLimits } from '../../config/limits.js';
import { Workflow, type Task } from '../../domain/workflow.js';
import { deepEqual } from '../../domain/deep-equal.js';
import { guidedPlanDigest, normalizeGuidedPlan } from '../../domain/guided-plan.js';
import { assertTaskExecutionIdle } from '../../execution/execution-state.js';
import { Executions } from '../../execution/executions.js';
import { Sessions } from '../../execution/sessions.js';
import { Workspaces } from '../../repository/workspaces.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import { Checks } from '../../verification/checks.js';
import { selectedLenses, type QualityAssessment } from '../../domain/quality-passes.js';
import { processAlive } from '../../verification/check-recovery.js';
import { currentProcessStartedAt } from '../../process/process-identity.js';
import { evidenceIds, type GuidedContext, type StageOutcome, type StateUpdate, type StopInput } from './context.js';
import { guidedDecisionDigest, guidedDecisionKey, guidedQuestionKey } from './keys.js';
import { rerunChecksIneligibility } from './rerun.js';
import { assertRunnerAvailable } from './runner-pool.js';
import { recoverLeafOperations } from './recovery.js';
import { implementationRetrySnapshot, preparationRetrySnapshot, prepareRetry, prepareReviewRetry } from './retry.js';
import { draftRevision, requireLinkedSessionsSettled, revisedState } from './revision.js';
import { afterImplementation } from './specs.js';
import { keepSnapshot } from './snapshots.js';
import { stageHandlers } from './stages/index.js';
import {
  freshRepairCycle,
  freshReviewCycle,
  isProgressStatus,
  required,
  type GuidedServices,
  type GuidedState,
  type Pending,
  type Status,
} from './state.js';
import { GuidedStopError, errorReasonCode, stopReason } from './stop-reasons.js';
import { createGuidance, requireGuidanceSpace, selectGuidance, type GuidanceTarget } from './guidance.js';
import { isSpendingStop, spendingStop } from './spending.js';
import { diagnosticApproval } from './diagnostic-approval.js';

const draftNote = 'Inspect the brief, selected files, commands, expected output and pinned base before approving.';

/** How a caller claims the runner; see {@link GuidedTasks.take}. */
interface Claim {
  /** Explicit recovery: may displace this task's own provably dead owner, and skips the plan checks. */
  recover?: boolean;
  /** The statuses the task must be in when the claim is made. */
  expected?: Status | Status[];
  /** Revision works on an unapproved plan and never starts work, so it needs no runner pool slot. */
  unapproved?: boolean;
}

/** Moves the state to a stop status, recording the note and its typed reason together. */
function markStopped(state: GuidedState, status: Status, { code, note }: StopInput): void {
  state.status = status;
  state.note = note;
  state.stopReason = stopReason(code, note);
}

/**
 * Sequential, explicit continuation over the existing controller; no provider/Git replay. Each step
 * journals its intent with the result ids already known, dispatches one leaf operation, then adopts
 * exactly one new matching result. Anything uncertain stops for explicit recovery.
 */
export class GuidedTasks {
  private readonly workflow: Workflow;
  private readonly workspaces: Workspaces;
  private readonly executions: Executions;
  private readonly checks: Checks;
  constructor(
    private readonly store: Store,
    private readonly services: GuidedServices = {},
  ) {
    this.workflow = new Workflow(store);
    this.workspaces = services.workspaces ?? new Workspaces(store);
    this.executions = new Executions(store, this.workspaces);
    this.checks = new Checks(store, this.workspaces);
  }
  /** The guided state of a task. */
  get(id: string): GuidedState {
    const state = this.workflow.get(id).guided;
    if (!state) throw new Error('This task has no guided plan');
    return state;
  }
  /**
   * Creates an unapproved guided task from a plan; nothing runs until its exact digest is approved.
   * Throws for an in-memory journal, since ownership and recovery need durable records, and for a plan
   * that fails normalisation.
   */
  create(input: unknown, directory?: string): Task {
    if (this.store.path === ':memory:') throw new Error('Guided tasks require a durable journal');
    const plan = normalizeGuidedPlan(input, directory);
    return this.store.transaction(() => {
      const task = this.workflow.create(plan.brief);
      task.guided = {
        version: task.version,
        plan,
        digest: guidedPlanDigest(plan),
        approvedDigest: null,
        implementationContinuation: null,
        reviewContinuation: null,
        retryAnchor: null,
        failedCheckId: null,
        repairCycle: freshRepairCycle(),
        readinessCycle: freshRepairCycle(),
        reviewCycle: freshReviewCycle(),
        status: 'draft',
        stage: 'workspace',
        sliceIndex: 0,
        workspaceId: null,
        executionId: null,
        reviewId: null,
        validationId: null,
        snapshot: null,
        policy: null,
        owner: null,
        pending: null,
        stopRequested: false,
        pauseRequested: false,
        guidance: [],
        assessments: [],
        qualityEdits: [],
        answers: null,
        feedback: '',
        note: draftNote,
        stopReason: stopReason('APPROVAL_REQUIRED', draftNote),
      };
      this.store.save(task.id, task);
      this.store.append(task.id, task.version, 'guided.created', {
        digest: task.guided.digest,
        status: task.guided.status,
        stage: task.guided.stage,
        sliceIndex: task.guided.sliceIndex,
        owner: null,
        pending: null,
        plan,
        reasonCode: 'APPROVAL_REQUIRED',
      });
      return task;
    });
  }
  /** The state, refusing a deleted task or one whose plan no longer matches its task record. */
  private current(id: string, approved = true): GuidedState {
    const task = this.workflow.get(id),
      state = this.get(id);
    if (task.deletedAt) throw new Error('This task was deleted from the dashboard');
    if (
      task.version !== state.version ||
      !deepEqual(task.brief, state.plan.brief) ||
      guidedPlanDigest(state.plan) !== state.digest
    )
      throw new Error('The guided plan is stale or changed; inspect the task through the ordinary CLI');
    if (approved && (task.approvedVersion !== state.version || state.approvedDigest !== state.digest))
      throw new Error('Approve the exact guided plan with task-approve first');
    return state;
  }
  /**
   * Saves one change and its journal event in one transaction, fenced on the ownership token. The
   * stop reason is cleared whenever the status shows progress, so it can never outlive its stop.
   */
  private change(
    id: string,
    token: string | null,
    type: string,
    update: StateUpdate,
    details: Record<string, unknown> = {},
  ): GuidedState {
    return this.store.transaction(() => {
      const task = this.workflow.get(id),
        state = task.guided;
      if (!state || (token !== null && state.owner?.token !== token))
        throw new Error('Guided controller ownership changed');
      update(state);
      if (isProgressStatus(state.status)) state.stopReason = null;
      this.store.save(id, task);
      this.store.append(id, task.version, type, {
        ...details,
        status: state.status,
        stage: state.stage,
        sliceIndex: state.sliceIndex,
        workspaceId: state.workspaceId,
        executionId: state.executionId,
        reviewId: state.reviewId,
        pending: state.pending,
        note: state.note,
        reasonCode: state.stopReason?.code ?? null,
        digest: state.digest,
        approvedDigest: state.approvedDigest,
        owner: state.owner,
        stopRequested: state.stopRequested,
        pauseRequested: state.pauseRequested,
        artifact: state.snapshot?.artifact ?? null,
        instructionsDigest: state.snapshot?.instructionsDigest ?? null,
        policy: state.policy,
        assessments: state.assessments,
        qualityEdits: state.qualityEdits,
        reviewCycle: state.reviewCycle,
        repairCycle: state.repairCycle,
        readinessCycle: state.readinessCycle,
        failedCheckId: state.failedCheckId,
      });
      return state;
    });
  }
  /**
   * Approves the exact current draft version and plan digest. Throws when either differs from the
   * current draft, so an approval can never apply to a plan the person did not see.
   */
  approve(id: string, version: number, digest: string): GuidedState {
    return this.store.transaction(() => {
      const state = this.current(id, false);
      this.requireExpected(state);
      if (state.owner || state.status !== 'draft' || version !== state.version || digest !== state.digest)
        throw new Error('Approval must name the current draft version and guided plan digest');
      this.workflow.approve(id, version);
      return this.change(id, null, 'guided.approved', state => {
        state.approvedDigest = digest;
        state.status = 'ready';
        state.note = 'Run the task to prepare its workspace and inspect the native execution checkpoint.';
      });
    });
  }
  /**
   * Claims this task's runner. Ownership never expires: a previous owner is displaced only by
   * recovery, and only once it is provably gone from this host. A claim that starts work (anything but
   * recovery, workspace release or revision, which never start an agent turn or check) needs a free
   * slot in the runner pool ({@link assertRunnerAvailable}); recovery may always displace its own task's
   * dead owner, so a full pool of crashed owners can still be recovered.
   */
  private take(id: string, { recover = false, expected, unapproved = false }: Claim = {}): string {
    requireComparisonMember(this.store, id);
    // Process identity queries start PowerShell; run them before taking the journal's write lock so
    // concurrent tasks are not kept waiting. A dead owner stays dead, so the verdict holds for its token.
    const startedAt = currentProcessStartedAt();
    const previous = recover ? this.get(id).owner : null;
    const previousGone =
      previous !== null &&
      previous.host === hostname() &&
      !processAlive(previous.controllerPid, previous.controllerStartedAt);
    return this.store.transaction(() => {
      // The comparison may advance while process identity is inspected. Membership and the runner
      // claim must share the write lock, otherwise a settled member could start outside its turn.
      requireComparisonMember(this.store, id);
      if (!recover) this.current(id, !unapproved);
      const state = this.get(id);
      this.requireExpected(state);
      if (expected && !(Array.isArray(expected) ? expected : [expected]).includes(state.status))
        throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
      if (state.owner) {
        if (!recover)
          throw new Error('This task has an active or uncertain guided controller; use task-recover after it exits');
        if (!previousGone || state.owner.token !== previous?.token)
          throw new Error('Previous guided controller is still alive, on another host or unverifiable');
      } else if (!recover && !unapproved) assertRunnerAvailable(this.store);
      const token = randomUUID();
      this.change(
        id,
        null,
        'guided.controller_claimed',
        state => {
          state.owner = {
            token,
            controllerPid: process.pid,
            controllerStartedAt: startedAt,
            host: hostname(),
          };
          state.stopRequested = false;
          if (!recover) state.pauseRequested = false;
        },
        { recovering: recover },
      );
      return token;
    });
  }
  /**
   * Revises at an idle checkpoint, preserving delivered prefixes and all worktree bytes. The revised
   * plan is a new draft that needs fresh approval. Throws when the task is owned, pending, needs
   * recovery, changed while the revision was prepared, or the revision itself is refused.
   */
  async revise(id: string, input: unknown, directory?: string, expectedVersion?: number): Promise<GuidedState> {
    const observed = this.current(id, false);
    if (expectedVersion !== undefined && expectedVersion !== observed.version)
      throw new Error('Task version changed; inspect the current plan before revising');
    this.requireExpected(observed);
    if (observed.owner || observed.pending || observed.status === 'recovery_required')
      throw new Error('Stop and recover active or uncertain work before revising');
    const token = this.take(id, { unapproved: true });
    try {
      const context = this.context(id, token);
      const draft = await draftRevision(context, observed, input, directory);
      this.store.transaction(() => {
        const state = this.current(id, false);
        if (state.owner?.token !== token || state.version !== observed.version || state.digest !== observed.digest)
          throw new Error('Task changed while preparing the revision');
        assertTaskExecutionIdle(this.store, id);
        requireLinkedSessionsSettled(context);
        this.workflow.revise(id, observed.version, draft.plan.brief);
        const revised = this.workflow.get(id);
        if (revised.slice) revised.slice = { index: draft.completed.length, completed: draft.completed };
        revised.guided = revisedState(
          state,
          draft,
          revised.version,
          draft.anchor ? keepSnapshot(this.store, draft.anchor) : null,
        );
        this.store.save(id, revised);
        if (draft.workspaceId) this.workspaces.rebind(draft.workspaceId, observed.version);
        this.store.append(id, revised.version, 'guided.revised', {
          previousVersion: observed.version,
          previousDigest: observed.digest,
          digest: revised.guided.digest,
          plan: draft.plan,
          preservedDeliveries: draft.completed,
          artifact: draft.anchor?.artifact ?? null,
          reasonCode: 'APPROVAL_REQUIRED',
        });
      });
    } finally {
      this.leave(id, token);
    }
    return this.get(id);
  }
  /** Refuses when the caller supplied the decision key it inspected and the task no longer matches it. */
  private requireExpected(state: GuidedState): void {
    if (
      this.services.expectedState !== undefined &&
      this.services.expectedState !== guidedDecisionKey(state, guidedQuestionKey(this.store, state))
    )
      throw new Error('Task changed since you inspected it; refresh before taking this action');
  }
  /** A held workspace lease or unfinished workspace creation means some operation may still be live. */
  private unsettled(id: string, state: GuidedState): boolean {
    if (state.workspaceId && this.store.lease(state.workspaceId)) return true;
    const workspace = this.workspaces.list().find(item => item.taskId === id);
    return !!workspace && !['ready', 'released'].includes(workspace.phase);
  }
  /** Releases the runner, unless a pending step or unsettled operation means ownership must survive for recovery. */
  private leave(id: string, token: string): void {
    this.change(id, token, 'guided.controller_checkpoint', state => {
      if (state.pending || this.unsettled(id, state)) {
        const explained = state.status === 'recovery_required' && state.stopReason !== null;
        state.status = 'recovery_required';
        state.note ||= 'Inspect settlement proof and run task-recover after this controller exits.';
        if (!explained) state.stopReason = stopReason('SETTLEMENT_UNCONFIRMED', state.note);
      } else state.owner = null;
    });
  }
  /**
   * Requests a stop; the running controller forwards it to the current leaf as an abort signal. Not
   * fenced on a token, so any process may ask; throws when no controller owns the task.
   */
  stop(id: string): GuidedState {
    return this.change(id, null, 'guided.stop_requested', state => {
      if (!state.owner) throw new Error('No guided controller is running');
      state.stopRequested = true;
      state.note = 'Stop requested; waiting for confirmed process settlement.';
    });
  }
  /** Requests a pause at the next settled boundary without interrupting the active operation. */
  pause(id: string): GuidedState {
    return this.change(id, null, 'guided.pause_requested', state => {
      this.requireExpected(state);
      if (!state.owner) throw new Error('No guided controller is running');
      if (state.stopRequested) throw new Error('A stop is already requested');
      state.pauseRequested = true;
      state.note = 'Pause requested; the current operation will finish before anything else starts.';
    });
  }
  /** Queues bounded guidance without starting or interrupting a turn or changing the approved plan. */
  queueGuidance(id: string, text: string, target: GuidanceTarget = 'next_agent'): GuidedState {
    const message = createGuidance(this.current(id), text, target);
    return this.change(
      id,
      null,
      'guided.guidance_queued',
      state => {
        this.current(id);
        this.requireExpected(state);
        requireGuidanceSpace(state, message);
        state.guidance.push(message);
      },
      { message },
    );
  }
  /** Cancels only an unassigned message. Guidance frozen into an active step cannot be withdrawn. */
  cancelGuidance(id: string, messageId: string): GuidedState {
    return this.change(
      id,
      null,
      'guided.guidance_cancelled',
      state => {
        this.current(id);
        this.requireExpected(state);
        if (!state.guidance.some(message => message.id === messageId))
          throw new Error('This guidance is no longer queued; refresh to inspect its assignment');
        state.guidance = state.guidance.filter(message => message.id !== messageId);
        if (state.stopReason?.code === 'GUIDANCE_PENDING' && !state.guidance.length) {
          state.status = 'ready';
          state.note = 'Pending guidance cleared. Continue explicitly to deliver the verified work.';
        }
      },
      { messageId },
    );
  }
  /** The handler context for one owned run. */
  private context(id: string, token: string): GuidedContext {
    const context: GuidedContext = {
      id,
      token,
      store: this.store,
      services: this.services,
      workflow: this.workflow,
      workspaces: this.workspaces,
      executions: this.executions,
      checks: this.checks,
      change: (type, update) => this.change(id, token, type, update),
      prepareRetry: (type, explicitSnapshot) => prepareRetry(context, type, explicitSnapshot),
    };
    return context;
  }
  /** The result ids that already exist for the current stage, so settlement can find the one new result. */
  private known(context: GuidedContext, state: GuidedState): string[] {
    return state.stage === 'complete' ? evidenceIds(context) : stageHandlers[state.stage].known(context, state);
  }
  /**
   * Journals the step intent (`guided.step_requested`) before any dispatch: the known result ids and
   * this controller's identity, which settlement and recovery later require the result to match. A step
   * already pending is never begun again, because its leaf may have run.
   */
  private begin(id: string, token: string): GuidedState {
    const state = this.current(id);
    if (state.pending) throw new Error('An earlier step needs explicit recovery; nothing will be replayed');
    const known = this.known(this.context(id, token), state);
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current.stage === 'delivery' && current.guidance.length) {
        return this.change(id, token, 'guided.guidance_waiting', state => {
          state.pauseRequested = false;
          markStopped(state, 'blocked', {
            code: 'GUIDANCE_PENDING',
            note: 'Guidance remains queued, but no agent turn is scheduled before delivery. Cancel it to continue, or revise the plan for more work.',
          });
        });
      }
      // This check and the dispatch intent share a transaction, so a concurrent pause cannot be lost.
      if (current.pauseRequested) {
        return this.change(id, token, 'guided.paused', state => {
          state.pauseRequested = false;
          markStopped(state, 'blocked', {
            code: 'USER_PAUSED',
            note: 'Paused between operations. Continue the task to resume the saved attempt.',
          });
        });
      }
      const budget = spendingStop(this.store, id, current);
      if (budget)
        return this.change(
          id,
          token,
          'guided.spending_blocked',
          state => {
            markStopped(state, 'blocked', budget.reason);
          },
          { spending: budget.spending },
        );
      return this.change(id, token, 'guided.step_requested', state => {
        const guidance = selectGuidance(state);
        state.guidance = guidance.remaining;
        state.pending = {
          stage: state.stage,
          known,
          assessment: state.assessments[0] ?? null,
          controller: { ...required(state, 'owner') },
          guidance: guidance.assigned,
        };
        state.status = 'running';
        state.note = `Running ${state.stage}.`;
      });
    });
  }
  private async perform(id: string, token: string, state: GuidedState, signal: AbortSignal) {
    if (state.stage === 'complete') return null;
    return stageHandlers[state.stage].perform({ ...this.context(id, token), state, signal });
  }
  /**
   * Settles the pending step from durable records, reading the state afresh rather than trusting what
   * `perform` saw. `recovering` is explicit recovery of a step a previous controller left pending.
   */
  private settle(id: string, token: string, snapshot: RepositorySnapshot | null = null, recovering = false): void {
    this.store.transaction(() => {
      const state = this.get(id),
        pending = required(state, 'pending');
      if (pending.stage === 'complete') return;
      const context = { ...this.context(id, token), state, pending, snapshot, recovering };
      this.apply(id, token, pending, stageHandlers[pending.stage].settle(context), recovering);
    });
  }
  /** Applies a settled step's outcome as one journaled change. */
  private apply(id: string, token: string, pending: Pending, outcome: StageOutcome, recovering: boolean): void {
    const advance = (stage: GuidedState['stage'], update?: StateUpdate, details: Record<string, unknown> = {}) =>
      this.change(
        id,
        token,
        recovering ? 'guided.step_reconciled' : 'guided.step_finished',
        state => {
          state.pending = null;
          state.stage = stage;
          state.status = stage === 'complete' ? 'complete' : 'ready';
          state.note = '';
          update?.(state);
        },
        details,
      );
    switch (outcome.kind) {
      case 'advance':
        advance(outcome.next, outcome.update);
        return;
      case 'wait':
        advance(outcome.next, state => {
          outcome.update?.(state);
          markStopped(state, outcome.status, outcome.reason);
        });
        return;
      case 'stop': {
        // A prompt budget refusal is settled before provider dispatch, so its guidance was never sent.
        const unsent = outcome.reason.code === 'PROMPT_BUDGET_EXCEEDED' ? pending.guidance : [];
        this.change(
          id,
          token,
          'guided.blocked',
          state => {
            state.pending = null;
            state.guidance = [...unsent, ...state.guidance];
            markStopped(state, 'blocked', outcome.reason);
          },
          unsent.length ? { restoredGuidance: unsent.map(message => message.id) } : undefined,
        );
        return;
      }
      case 'missing':
        if (!recovering) throw new GuidedStopError('RESULT_MISSING', 'The operation returned without a durable result');
        // Explicit recovery proves no leaf dispatch, so the unspent batch can be restored safely.
        advance(
          pending.stage,
          state => {
            state.guidance = [...pending.guidance, ...state.guidance];
          },
          { restoredGuidance: pending.guidance.map(message => message.id) },
        );
        return;
      case 'rerouted':
        return;
    }
  }
  /**
   * Runs steps while the task is ready. A failure after the leaf may have dispatched (it returned,
   * recorded a new result, or left the workspace unsettled) requires recovery; one before dispatch
   * only blocks, because nothing can have happened that needs reconciling.
   */
  private async drive(id: string, token: string, signal: AbortSignal): Promise<GuidedState> {
    while (this.get(id).status === 'ready') {
      if (signal.aborted) {
        this.change(id, token, 'guided.stopped_between_steps', state => {
          state.note = 'Stopped between operations. Use task-run to continue explicitly.';
        });
        break;
      }
      let operationReturned = false;
      try {
        const state = this.begin(id, token);
        if (state.status !== 'running') break;
        const snapshot = await this.perform(id, token, state, signal);
        operationReturned = true;
        this.settle(id, token, snapshot);
      } catch (error) {
        const restoredGuidance: string[] = [];
        this.change(
          id,
          token,
          'guided.step_failed',
          state => {
            const note = error instanceof Error ? error.message : String(error);
            state.note = note;
            const pending = state.pending;
            const recorded =
              pending && this.known(this.context(id, token), state).some(value => !pending.known.includes(value));
            if (pending && (operationReturned || recorded || this.unsettled(id, state)))
              markStopped(state, 'recovery_required', { code: errorReasonCode(error, 'RECOVERY_REQUIRED'), note });
            else {
              markStopped(state, 'blocked', { code: errorReasonCode(error, 'UNEXPECTED_ERROR'), note });
              // No leaf result or unsettled operation exists, so these messages were never dispatched.
              state.guidance = [...(pending?.guidance ?? []), ...state.guidance];
              restoredGuidance.push(...(pending?.guidance.map(message => message.id) ?? []));
              state.pending = null;
            }
          },
          { restoredGuidance },
        );
        break;
      }
    }
    return this.get(id);
  }
  /** Runs `action` while owning the runner, forwarding persisted stop requests as an abort signal. */
  private async owned(
    id: string,
    action: (token: string, signal: AbortSignal) => Promise<unknown>,
    { signal, ...claim }: Omit<Claim, 'unapproved'> & { signal?: AbortSignal | undefined } = {},
  ): Promise<GuidedState> {
    const token = this.take(id, claim),
      abort = new AbortController();
    const timer = setInterval(() => {
      try {
        if (this.get(id).stopRequested) abort.abort();
      } catch {
        // A task that can no longer be read is treated as a stop request rather than left running.
        abort.abort();
      }
    }, processLimits.stopPollMs);
    try {
      await action(token, signal ? AbortSignal.any([signal, abort.signal]) : abort.signal);
    } finally {
      clearInterval(timer);
      this.leave(id, token);
    }
    return this.get(id);
  }
  /**
   * Runs a ready task until it completes or stops. Throws when the task is not ready, is owned, or the
   * runner pool is full (`RunnerPoolFullError`).
   */
  async run(id: string, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'ready' && state.stopReason?.code !== 'USER_PAUSED')
      throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
    return this.owned(
      id,
      async (token, signal) => {
        this.change(id, token, 'guided.continued', current => {
          if (current.status !== 'ready' && current.stopReason?.code !== 'USER_PAUSED')
            throw new Error('The task is no longer ready or paused; inspect its current stop before continuing');
          current.status = 'ready';
        });
        await this.drive(id, token, signal);
      },
      { signal, expected: state.status },
    );
  }
  /** Supervised mode: confirms native execution from the inspected workspace checkpoint and continues. */
  async authorize(id: string, signal?: AbortSignal): Promise<GuidedState> {
    if (this.current(id).status !== 'awaiting_scope') throw new Error('No workspace confirmation is pending');
    return this.owned(
      id,
      async (token, signal) => {
        this.change(id, token, 'guided.scope_authorized', state => {
          state.stage = state.policy === null ? afterImplementation(state) : 'implementation';
          state.status = 'ready';
        });
        await this.drive(id, token, signal);
      },
      { signal, expected: 'awaiting_scope' },
    );
  }
  /**
   * Supervised mode: records a person's quality assessment of the current artifact and continues. One
   * outcome and summary cover every selected lens, and are recorded as evidence for each of them.
   */
  async assess(
    id: string,
    outcome: QualityAssessment['outcome'],
    summary: string,
    signal?: AbortSignal,
  ): Promise<GuidedState> {
    const state = this.current(id);
    const lenses = selectedLenses(state.plan.quality);
    if (state.status !== 'awaiting_assessment' || !state.snapshot || !lenses.length)
      throw new Error('No quality assessment is pending');
    if (
      !['passed', 'failed', 'skipped'].includes(outcome) ||
      typeof summary !== 'string' ||
      !summary.trim() ||
      Buffer.byteLength(summary) > planLimits.textBytes
    )
      throw new Error(
        `Choose passed/failed/skipped and supply a concrete summary (at most ${planLimits.textBytes} bytes)`,
      );
    return this.owned(
      id,
      async (token, signal) => {
        this.change(id, token, 'guided.assessment_supplied', state => {
          const snapshot = required(state, 'snapshot');
          state.assessments = lenses.map(lens => ({
            pass: lens.id,
            artifact: snapshot.artifact,
            instructionsDigest: snapshot.instructionsDigest,
            outcome,
            summary,
          }));
          state.status = 'ready';
        });
        await this.drive(id, token, signal);
      },
      { signal, expected: 'awaiting_assessment' },
    );
  }
  /** Approves the displayed bounded supplement without changing the plan or resetting diagnostic spending. */
  async approveDiagnosticAllowance(
    id: string,
    expected: string,
    signal?: AbortSignal,
    answers?: Record<string, string>,
  ): Promise<GuidedState> {
    const proposal = diagnosticApproval(this.store, this.current(id), expected, answers);
    return this.owned(
      id,
      async (token, signal) => {
        this.change(
          id,
          token,
          'guided.diagnostic_allowance_approved',
          current => {
            if (diagnosticApproval(this.store, current, expected, answers).requestId !== proposal.requestId)
              throw new Error('Diagnostic allowance request changed');
            current.status = 'ready';
            current.stage = 'scope';
            current.answers = answers ?? null;
          },
          proposal,
        );
        await this.drive(id, token, signal);
      },
      { signal, expected: 'blocked' },
    );
  }
  /** Answers every pending agent question by id and resumes the same conversation. */
  async answer(id: string, answers: Record<string, string>, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'awaiting_answer') throw new Error('No guided questions are pending');
    const execution = this.executions.get(required(state, state.stage === 'review' ? 'reviewId' : 'executionId'));
    const reply = new Sessions(this.store).get(execution.sessionId).lastReply;
    if (!reply) throw new Error('No guided questions are pending');
    const questions = reply.questions;
    if (
      !answers ||
      typeof answers !== 'object' ||
      Array.isArray(answers) ||
      Object.keys(answers).length !== questions.length ||
      questions.some(question => {
        const answer = answers[question.id];
        return typeof answer !== 'string' || !answer.trim();
      })
    )
      throw new Error('Answer every pending question by id');
    return this.owned(
      id,
      async (token, signal) => {
        this.change(id, token, 'guided.answers_supplied', state => {
          state.answers = structuredClone(answers);
          state.status = 'ready';
          // Answers to implementation questions are given to a new turn on a freshly scoped snapshot.
          if (state.stage === 'implementation') state.stage = 'scope';
        });
        await this.drive(id, token, signal);
      },
      { signal, expected: 'awaiting_answer' },
    );
  }
  /**
   * Retries from a settled stop. A stopped preparation reruns in the same attempt without repeating
   * implementation; anything else starts a new implementation attempt with the failure as feedback.
   */
  async retry(id: string, signal?: AbortSignal): Promise<GuidedState> {
    const comparison = this.store.comparisons().find(group => group.runs.some(run => run.taskId === id));
    if (comparison && comparisonRetries(this.store, comparison.id).active?.taskId !== id) {
      const { expectedState, ...services } = this.services;
      return new Comparisons(this.store, services).retry(id, expectedState, signal);
    }
    if (isSpendingStop(this.current(id).stopReason?.code))
      throw new Error('Revise the task spending policy and obtain fresh approval before retrying');
    const allowed: Status[] = ['blocked', 'awaiting_scope', 'awaiting_assessment'];
    if (!allowed.includes(this.current(id).status))
      throw new Error('Retry requires a settled checkpoint or failure; recover uncertain work first');
    return this.owned(
      id,
      async (token, signal) => {
        const state = this.get(id),
          context = this.context(id, token);
        if (state.pending || this.unsettled(id, state))
          throw new Error('Recover the unfinished operation before retrying');
        if (state.status === 'blocked' && (state.stage === 'preparation' || state.stage === 'refresh')) {
          const snapshot = await preparationRetrySnapshot(context, state);
          this.change(id, token, 'guided.preparation_retry_requested', current => {
            current.snapshot = keepSnapshot(this.store, snapshot);
            current.status = 'ready';
            current.note = '';
          });
          await this.drive(id, token, signal);
          return;
        }
        // A review turn without a verdict is retried as a review; anything else is a new attempt.
        if (state.status === 'blocked' && state.stage === 'review' && state.stopReason?.code === 'REVIEW_TURN_FAILED')
          await prepareReviewRetry(context, state);
        else prepareRetry(context, 'guided.retry_requested', await implementationRetrySnapshot(context, state));
        await this.drive(id, token, signal);
      },
      { signal, expected: allowed },
    );
  }
  /**
   * Reruns a stopped validation or acceptance check on the unchanged artifact without a new
   * implementation attempt: no agent turn, the same execution and attempt, and a new check record
   * under the usual evidence binding. Only infrastructure stops whose check settled qualify
   * ({@link rerunChecksIneligibility}); automatic mode never reruns on its own, so a timeout is always
   * surfaced. `expectedDecision` is the digest of the decision key the caller inspected.
   */
  async rerunChecks(id: string, expectedDecision: string, signal?: AbortSignal): Promise<GuidedState> {
    const eligible = (): GuidedState => {
      const state = this.current(id);
      if (expectedDecision !== guidedDecisionDigest(state, guidedQuestionKey(this.store, state)))
        throw new Error('Task changed since you inspected it; refresh before taking this action');
      const problem = rerunChecksIneligibility(this.store, this.workflow.get(id));
      if (problem) throw new Error(problem);
      return state;
    };
    eligible();
    return this.owned(
      id,
      async (token, signal) => {
        // Claiming the runner leaves the decision key unchanged, so the inspected decision must still apply.
        const state = eligible();
        if (this.unsettled(id, state)) throw new Error('Recover the unfinished operation before rerunning checks');
        const snapshot = await this.checks.snapshot(required(state, 'executionId'));
        const checked = required(state, 'snapshot');
        if (snapshot.artifact !== checked.artifact || snapshot.instructionsDigest !== checked.instructionsDigest)
          throw new Error(
            'The workspace changed since the check ran; rerun checks applies only to the unchanged artifact. Use task-retry for a new attempt or revise the plan.',
          );
        this.change(id, token, 'guided.checks_rerun_requested', current => {
          current.status = 'ready';
          current.note = '';
        });
        await this.drive(id, token, signal);
      },
      { signal, expected: 'blocked' },
    );
  }
  /**
   * Explicit recovery: reconciles the leaf operation and the pending step from durable records. It
   * never sends a turn, reruns a command or repeats a Git write, and never starts the next step.
   */
  async recover(id: string): Promise<GuidedState> {
    const previous = this.get(id);
    if (!previous.owner && !previous.pending && previous.status !== 'recovery_required')
      throw new Error('No guided recovery is needed');
    return this.owned(
      id,
      async token => {
        // Journals the person's request itself, so usage reports can count it as an intervention
        // whichever outcome the reconciliation below records.
        this.change(id, token, 'guided.recovery_requested', () => {});
        try {
          const state = this.get(id);
          await recoverLeafOperations(this.context(id, token));
          if (state.pending) this.settle(id, token, null, true);
          else
            this.change(id, token, 'guided.controller_reconciled', state => {
              if (state.status === 'running' || state.status === 'recovery_required') state.status = 'ready';
            });
        } catch (error) {
          this.change(id, token, 'guided.recovery_blocked', state => {
            const note = error instanceof Error ? error.message : String(error);
            markStopped(state, 'recovery_required', { code: errorReasonCode(error, 'RECOVERY_BLOCKED'), note });
          });
        }
      },
      { recover: true },
    );
  }
  /** Releases an unused workspace-creation reservation (metadata only; files and branches are kept). */
  async releaseWorkspace(id: string): Promise<GuidedState> {
    return this.owned(
      id,
      async token => {
        const state = this.get(id),
          workspace = this.workspaces.list().find(item => item.taskId === id);
        if (
          !workspace ||
          state.stage !== 'workspace' ||
          state.workspaceId ||
          (state.pending && state.pending.stage !== 'workspace')
        )
          throw new Error('No unused workspace-creation reservation is pending');
        await this.workspaces.release(workspace.id);
        this.change(id, token, 'guided.workspace_released', current => {
          current.pending = null;
          current.status = 'ready';
          current.note =
            'Unused reservation released; files and branches were retained. Continue explicitly to create a new workspace.';
        });
      },
      { recover: true },
    );
  }
}
