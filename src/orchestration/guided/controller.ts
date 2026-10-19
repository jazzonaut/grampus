// Owns the guided task controller: its public API for the CLI, dashboard and tests, claiming and
// releasing the single runner, the drive loop, and every journaled change of guided state. What each
// stage dispatches and how it settles lives in ./stages; prompts in ./prompts.ts.
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
import { recoverLeafOperations } from './recovery.js';
import { implementationRetrySnapshot, preparationRetrySnapshot, prepareRetry } from './retry.js';
import { draftRevision, requireLinkedSessionsSettled, revisedState } from './revision.js';
import { afterImplementation } from './specs.js';
import { keepSnapshot } from './snapshots.js';
import { stageHandlers } from './stages/index.js';
import {
  freshRepairCycle,
  freshReviewCycle,
  isProgressStatus,
  type GuidedServices,
  type GuidedState,
  type Pending,
  type Status,
} from './state.js';
import { GuidedStopError, errorReasonCode, stopReason } from './stop-reasons.js';

const draftNote = 'Inspect the brief, selected files, commands, expected output and pinned base before approving.';

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
  /** Creates an unapproved guided task from a plan; nothing runs until its exact digest is approved. */
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
  private change(id: string, token: string | null, type: string, update: StateUpdate): GuidedState {
    return this.store.transaction(() => {
      const task = this.workflow.get(id),
        state = task.guided;
      if (!state || (token !== null && state.owner?.token !== token))
        throw new Error('Guided controller ownership changed');
      update(state);
      if (isProgressStatus(state.status)) state.stopReason = null;
      this.store.save(id, task);
      this.store.append(id, task.version, type, {
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
        artifact: state.snapshot?.artifact ?? null,
        instructionsDigest: state.snapshot?.instructionsDigest ?? null,
        policy: state.policy,
        assessments: state.assessments,
        qualityEdits: state.qualityEdits,
        reviewCycle: state.reviewCycle,
        repairCycle: state.repairCycle,
        failedCheckId: state.failedCheckId,
      });
      return state;
    });
  }
  /** Approves the exact current draft version and plan digest. */
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
        state.note = 'Run the task to prepare its workspace and inspect the exact file authorization.';
      });
    });
  }
  /**
   * Claims the single runner for this task. Ownership never expires: a previous owner is displaced
   * only by recovery, and only once it is provably gone from this host.
   */
  private take(id: string, recover = false, expected?: Status | Status[], unapproved = false): string {
    return this.store.transaction(() => {
      if (!recover) this.current(id, !unapproved);
      const state = this.get(id);
      this.requireExpected(state);
      if (expected && !(Array.isArray(expected) ? expected : [expected]).includes(state.status))
        throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
      // An indexed column of the tasks table: no other task's state is parsed to find the owner.
      const other = this.store.runnerOwners(id).at(0);
      if (other) throw new Error(`Another guided task owns the runner: ${other}. Inspect or recover it first.`);
      if (state.owner) {
        if (!recover)
          throw new Error('This task has an active or uncertain guided controller; use task-recover after it exits');
        if (state.owner.host !== hostname() || processAlive(state.owner.controllerPid, state.owner.controllerStartedAt))
          throw new Error('Previous guided controller is still alive, on another host or unverifiable');
      }
      const token = randomUUID();
      this.change(id, null, 'guided.controller_claimed', state => {
        state.owner = {
          token,
          controllerPid: process.pid,
          controllerStartedAt: currentProcessStartedAt(),
          host: hostname(),
        };
        state.stopRequested = false;
      });
      return token;
    });
  }
  /** Revise at an idle checkpoint; preserve delivered prefixes and all worktree bytes. */
  async revise(id: string, input: unknown, directory?: string, expectedVersion?: number): Promise<GuidedState> {
    const observed = this.current(id, false);
    if (expectedVersion !== undefined && expectedVersion !== observed.version)
      throw new Error('Task version changed; inspect the current plan before revising');
    this.requireExpected(observed);
    if (observed.owner || observed.pending || observed.status === 'recovery_required')
      throw new Error('Stop and recover active or uncertain work before revising');
    const token = this.take(id, false, undefined, true);
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
  /** Requests a stop; the running controller forwards it to the current leaf as an abort signal. */
  stop(id: string): GuidedState {
    return this.change(id, null, 'guided.stop_requested', state => {
      if (!state.owner) throw new Error('No guided controller is running');
      state.stopRequested = true;
      state.note = 'Stop requested; waiting for confirmed process settlement.';
    });
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
  private known(context: GuidedContext, state: GuidedState): string[] {
    return state.stage === 'complete' ? evidenceIds(context) : stageHandlers[state.stage].known(context, state);
  }
  private begin(id: string, token: string): GuidedState {
    const state = this.current(id);
    if (state.pending) throw new Error('An earlier step needs explicit recovery; nothing will be replayed');
    const known = this.known(this.context(id, token), state);
    return this.change(id, token, 'guided.step_requested', state => {
      state.pending = {
        stage: state.stage,
        known,
        assessment: state.assessments[0] ?? null,
        controller: { ...state.owner! },
      };
      state.status = 'running';
      state.note = `Running ${state.stage}.`;
    });
  }
  private async perform(id: string, token: string, state: GuidedState, signal: AbortSignal) {
    if (state.stage === 'complete') return null;
    return stageHandlers[state.stage].perform({ ...this.context(id, token), state, signal });
  }
  private settle(id: string, token: string, snapshot: RepositorySnapshot | null = null, recovering = false): void {
    const state = this.get(id),
      pending = state.pending!;
    if (pending.stage === 'complete') return;
    const context = { ...this.context(id, token), state, pending, snapshot, recovering };
    this.apply(id, token, pending, stageHandlers[pending.stage].settle(context), recovering);
  }
  /** Applies a settled step's outcome as one journaled change. */
  private apply(id: string, token: string, pending: Pending, outcome: StageOutcome, recovering: boolean): void {
    const advance = (stage: GuidedState['stage'], update?: StateUpdate) =>
      this.change(id, token, recovering ? 'guided.step_reconciled' : 'guided.step_finished', state => {
        state.pending = null;
        state.stage = stage;
        state.status = stage === 'complete' ? 'complete' : 'ready';
        state.note = '';
        update?.(state);
      });
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
      case 'stop':
        this.change(id, token, 'guided.blocked', state => {
          state.pending = null;
          markStopped(state, 'blocked', outcome.reason);
        });
        return;
      case 'missing':
        if (!recovering) throw new GuidedStopError('RESULT_MISSING', 'The operation returned without a durable result');
        advance(pending.stage); // Explicit recovery proves no leaf dispatch; the next task-run remains explicit.
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
        const state = this.begin(id, token),
          snapshot = await this.perform(id, token, state, signal);
        operationReturned = true;
        this.settle(id, token, snapshot);
      } catch (error) {
        this.change(id, token, 'guided.step_failed', state => {
          const note = error instanceof Error ? error.message : String(error);
          state.note = note;
          const recorded =
            state.pending &&
            this.known(this.context(id, token), state).some(value => !state.pending!.known.includes(value));
          if (state.pending && (operationReturned || recorded || this.unsettled(id, state)))
            markStopped(state, 'recovery_required', { code: errorReasonCode(error, 'RECOVERY_REQUIRED'), note });
          else {
            markStopped(state, 'blocked', { code: errorReasonCode(error, 'UNEXPECTED_ERROR'), note });
            state.pending = null;
          }
        });
        break;
      }
    }
    return this.get(id);
  }
  /** Runs `action` while owning the runner, forwarding persisted stop requests as an abort signal. */
  private async owned(
    id: string,
    action: (token: string, signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
    recover = false,
    expected?: Status | Status[],
  ): Promise<GuidedState> {
    const token = this.take(id, recover, expected),
      abort = new AbortController();
    const timer = setInterval(() => {
      try {
        if (this.get(id).stopRequested) abort.abort();
      } catch {
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
  /** Runs a ready task until it completes or stops. */
  async run(id: string, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'ready') throw new Error(`Task is ${state.status}; inspect task-show for its next action`);
    return this.owned(id, (token, signal) => this.drive(id, token, signal), signal, false, 'ready');
  }
  /** Supervised mode: authorizes the displayed file scope and continues. */
  async authorize(id: string, signal?: AbortSignal): Promise<GuidedState> {
    if (this.current(id).status !== 'awaiting_scope') throw new Error('No file authorization is pending');
    return this.owned(
      id,
      async (token, signal) => {
        this.change(id, token, 'guided.scope_authorized', state => {
          state.stage = state.policy === null ? afterImplementation(state) : 'implementation';
          state.status = 'ready';
        });
        await this.drive(id, token, signal);
      },
      signal,
      false,
      'awaiting_scope',
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
          state.assessments = lenses.map(lens => ({
            pass: lens.id,
            artifact: state.snapshot!.artifact,
            instructionsDigest: state.snapshot!.instructionsDigest,
            outcome,
            summary,
          }));
          state.status = 'ready';
        });
        await this.drive(id, token, signal);
      },
      signal,
      false,
      'awaiting_assessment',
    );
  }
  /** Answers every pending agent question by id and resumes the same conversation. */
  async answer(id: string, answers: Record<string, string>, signal?: AbortSignal): Promise<GuidedState> {
    const state = this.current(id);
    if (state.status !== 'awaiting_answer') throw new Error('No guided questions are pending');
    const execution = this.executions.get(state.stage === 'review' ? state.reviewId! : state.executionId!);
    const questions = new Sessions(this.store).get(execution.sessionId).lastReply!.questions;
    if (
      !answers ||
      typeof answers !== 'object' ||
      Array.isArray(answers) ||
      Object.keys(answers).length !== questions.length ||
      questions.some(question => typeof answers[question.id] !== 'string' || !answers[question.id]!.trim())
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
      signal,
      false,
      'awaiting_answer',
    );
  }
  /**
   * Retries from a settled stop. A stopped preparation reruns in the same attempt without repeating
   * implementation; anything else starts a new implementation attempt with the failure as feedback.
   */
  async retry(id: string, signal?: AbortSignal): Promise<GuidedState> {
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
        prepareRetry(context, 'guided.retry_requested', await implementationRetrySnapshot(context, state));
        await this.drive(id, token, signal);
      },
      signal,
      false,
      allowed,
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
        const snapshot = await this.checks.snapshot(state.executionId!);
        if (
          snapshot.artifact !== state.snapshot!.artifact ||
          snapshot.instructionsDigest !== state.snapshot!.instructionsDigest
        )
          throw new Error(
            'The workspace changed since the check ran; rerun checks applies only to the unchanged artifact. Use task-retry for a new attempt or revise the plan.',
          );
        this.change(id, token, 'guided.checks_rerun_requested', current => {
          current.status = 'ready';
          current.note = '';
        });
        await this.drive(id, token, signal);
      },
      signal,
      false,
      'blocked',
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
      undefined,
      true,
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
      undefined,
      true,
    );
  }
}
