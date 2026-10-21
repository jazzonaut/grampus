// Owns executions: the immutable binding of one task attempt to a workspace and a fresh session in a
// role (implementation or review), and explicit recovery of read-only operations a dead controller
// left holding a lease. It never runs a turn or a command itself.
import type { ReasoningEffort } from '../domain/model-profiles.js';
import { randomUUID } from 'node:crypto';
import type { Store } from '../persistence/store.js';
import { Workflow, type Attempt, type Task } from '../domain/workflow.js';
import { Sessions } from './sessions.js';
import { Workspaces, type Workspace } from '../repository/workspaces.js';
import type { Provider } from '../providers/types.js';
import { providerRuntime } from '../providers/executables.js';
import { assertTaskExecutionIdle, type Execution } from './execution-state.js';
import { requireDeadController } from '../verification/check-recovery.js';
import { snapshotRepository, type RepositorySnapshot } from '../repository/artifacts.js';
import { verifyNoChange } from '../repository/delivery-git.js';
import { sessionContinuation } from './session-context.js';
import type { Session } from '../persistence/records.js';

/** How a new execution is created. Every field has a default suitable for a first implementation. */
export interface ExecutionOptions {
  role?: Execution['role'];
  /** The approved model, or null for the provider default. */
  model?: string | null;
  effort?: ReasoningEffort;
  /** Required for a review by the implementer's provider; journaled with the review evidence. */
  fallbackReason?: string | null;
  /** A settled execution of the same role whose provider conversation may be resumed. */
  resumeFrom?: string | null;
  /** A review that is a fresh arbitration, so its usage is attributed to arbitration. */
  arbitration?: boolean;
}

/** The workspace as `Workspaces.inspect` observed it before the write transaction. */
type Inspected = Awaited<ReturnType<Workspaces['inspect']>>;

/** Leases of operations that never dispatch a repository-writing tool, so a dead owner can simply be released. */
const readOnlyKinds: readonly string[] = ['snapshot', 'submission', 'assessment', 'completion'];

/**
 * Whether `snapshot` is the workspace an approved revision was approved against at the current slice,
 * in which case changed instructions are part of the approval rather than drift.
 */
function approvedRevisionContinuation(task: Task, snapshot: RepositorySnapshot): boolean {
  const revision = task.guided?.plan.revision;
  return (
    !!revision &&
    revision.sliceIndex === task.slice?.index &&
    revision.artifact === snapshot.artifact &&
    revision.head === snapshot.head &&
    revision.instructionsDigest === snapshot.instructionsDigest
  );
}

/** Throws unless a review may start: the current attempt succeeded, and a same-provider review says why. */
function requireReviewable(task: Task, provider: Provider, fallbackReason: string | null): void {
  if (!['awaiting_verification', 'awaiting_decision'].includes(task.phase) || task.attempt?.outcome !== 'succeeded')
    throw new Error('Review requires a successful current attempt');
  if (task.attempt.agent.provider === provider && !fallbackReason?.trim())
    throw new Error('Same-provider review requires a fallback reason');
}

/** The inputs of {@link Executions.continueSession}. */
interface Continuation {
  session: Session;
  resumeFrom: string;
  task: Task;
  version: number;
  workspaceId: string;
  role: Execution['role'];
  provider: Provider;
  model: string | null;
}

/**
 * Whether `previous` may hand its conversation on: a closed execution of the same task, version,
 * workspace, role and slice, whose session (same provider) has settled with no pending questions.
 */
function resumable(previous: Execution, prior: Session, input: Continuation): boolean {
  const { task, version, workspaceId, role, provider } = input;
  return (
    previous.taskId === task.id &&
    previous.version === version &&
    previous.workspaceId === workspaceId &&
    previous.role === role &&
    previous.sliceIndex === (task.slice?.index ?? 0) &&
    previous.phase === 'closed' &&
    prior.provider === provider &&
    !prior.run &&
    !['running', 'stop_requested', 'recovery_required', 'awaiting_answer'].includes(prior.phase)
  );
}

/**
 * Creates, closes and recovers executions. Git inspection runs before the write transaction and is then
 * re-checked against the journal inside it, so a slow Git call never holds the journal lock.
 */
export class Executions {
  constructor(
    private readonly store: Store,
    private readonly workspaces = new Workspaces(store),
  ) {}
  get(id: string): Execution {
    return this.store.execution(id);
  }
  /** Every execution, or only `taskId`'s, in creation order. */
  list(taskId?: string): Execution[] {
    return this.store.executions(taskId);
  }

  /**
   * Releases the lease of a read-only operation (snapshot, submission, assessment or completion) whose
   * controller is provably dead. Such operations never dispatch a repository-writing tool, so there is
   * nothing to reconcile and nothing is replayed. Throws for any other lease kind, which needs its own
   * recovery.
   */
  recoverReadOnly(id: string): void {
    this.store.transaction(() => {
      const execution = this.get(id);
      const lease = this.store.lease(execution.workspaceId);
      if (lease?.executionId !== id || !lease.readOnlyRecovery || !readOnlyKinds.includes(lease.kind)) {
        throw new Error(
          'No recoverable read-only operation; command and conversation leases require their own recovery',
        );
      }
      requireDeadController(lease);
      if (new Sessions(this.store).get(execution.sessionId).run)
        throw new Error('A conversation still owns this session');
      this.store.releaseLease(execution.workspaceId, id, lease.runId);
      const event = {
        runId: lease.runId,
        kind: lease.kind,
        evidence: 'Controller absent; operation protocol never dispatches repository-writing tools',
        replayed: false,
      };
      this.store.appendExecution(id, 'operation.recovered', event);
      this.store.append(execution.taskId, execution.version, 'execution.operation_recovered', event);
    });
  }

  /**
   * Binds the current attempt to a fresh session in `options.role` (an implementation starts a new
   * attempt). The execution's usage stage is fixed here: an implementation is `repair` when the task
   * already has an implementation execution for this slice, and a review is `arbitration` when the
   * caller says it arbitrates. Throws unless the task's exact approved version, a ready workspace and,
   * for a later slice, the last delivered head with clean files are in place.
   */
  async create(
    workspaceId: string,
    version: number,
    provider: Provider,
    options: ExecutionOptions = {},
  ): Promise<Execution> {
    const { role = 'implementation', model = null, fallbackReason = null, resumeFrom = null } = options;
    if (!['implementation', 'review'].includes(role))
      throw new Error('Execution role must be implementation or review');
    const inspected = await this.workspaces.inspect(workspaceId);
    const continuation = role === 'implementation' ? await this.sliceContinuation(inspected) : null;
    // Resolved outside the write lock: the first resolution in a process runs `--version`.
    const runtime = providerRuntime(provider);
    return this.store.transaction(() => {
      const workspace = this.workspaces.get(workspaceId);
      const workflow = new Workflow(this.store);
      const task = workflow.get(workspace.taskId);
      const path = this.requireBinding(workspace, task, version, inspected);
      if (role === 'implementation') this.requireContinuationHead(task, inspected, continuation);
      if (role === 'review') requireReviewable(task, provider, fallbackReason);
      const session = new Sessions(this.store).create(provider, path, model, runtime, options.effort);
      if (resumeFrom) this.continueSession({ session, resumeFrom, task, version, workspaceId, role, provider, model });
      const attempt =
        role === 'implementation'
          ? workflow.start(task.id, { provider, model: model ?? 'provider-default', sessionId: session.id })
          : task.attempt;
      if (!attempt) throw new Error('Review requires an implementation attempt');
      const execution = this.newExecution(task, attempt, options, { workspaceId, sessionId: session.id, inspected });
      this.store.saveExecution(execution.id, task.id, workspaceId, session.id, execution);
      this.store.appendExecution(execution.id, 'execution.created', execution);
      this.store.append(task.id, version, 'execution.created', execution);
      this.store.appendSession(session.id, 'execution.linked', {
        executionId: execution.id,
        taskId: task.id,
        version,
        attemptId: attempt.id,
        workspaceId,
        role,
      });
      return execution;
    });
  }

  /**
   * The workspace snapshot a later slice continues from, verified (outside the write lock, because Git
   * runs) to be the delivered head with clean raw files and index unless an approved revision
   * anchored it. Null for the first slice or a task that is not ready for its next slice.
   */
  private async sliceContinuation(inspected: Inspected): Promise<RepositorySnapshot | null> {
    const task = new Workflow(this.store).get(inspected.workspace.taskId);
    if (task.phase !== 'ready' || !task.slice?.completed.length) return null;
    const workspace = inspected.workspace;
    const path = workspace.path;
    if (!path) throw new Error('Workspace has no path');
    const continuation = await snapshotRepository(path, workspace.baseCommit);
    if (!approvedRevisionContinuation(task, continuation))
      verifyNoChange({
        id: 'continuation',
        cwd: path,
        branch: `refs/heads/${workspace.branch}`,
        base: workspace.baseCommit,
        message: 'Verify slice continuation',
        snapshot: continuation,
      });
    // A second matching capture binds the Git checks above to the content that was hashed.
    const again = await snapshotRepository(path, workspace.baseCommit);
    if (again.artifact !== continuation.artifact)
      throw new Error('Repository changed while checking slice continuation');
    return continuation;
  }

  /** Throws unless the task and workspace are the exact approved version and idle; returns the workspace path. */
  private requireBinding(workspace: Workspace, task: Task, version: number, inspected: Inspected): string {
    if (
      workspace.phase !== 'ready' ||
      !workspace.path ||
      workspace.version !== version ||
      task.version !== version ||
      task.approvedVersion !== version ||
      !inspected.taskCurrent
    ) {
      throw new Error('Execution requires the exact approved task and ready workspace version');
    }
    assertTaskExecutionIdle(this.store, task.id);
    if (task.synthetic) throw new Error('Synthetic tasks cannot create executions');
    return workspace.path;
  }

  /**
   * A later slice's implementation must start at the last delivered head and, unless an approved
   * revision changed them, with the instructions that delivery was checked against.
   */
  private requireContinuationHead(task: Task, inspected: Inspected, continuation: RepositorySnapshot | null): void {
    const previous = task.slice?.completed.at(-1);
    if (!previous) return;
    if (inspected.head !== previous.head) throw new Error('HEAD differs from the last delivered slice');
    if (task.phase !== 'ready') return;
    const delivery = this.store.delivery(previous.deliveryId);
    if (
      !continuation ||
      continuation.head !== previous.head ||
      (!approvedRevisionContinuation(task, continuation) &&
        continuation.instructionsDigest !== delivery.spec.instructionsDigest)
    ) {
      throw new Error(
        'Slice continuation requires the last delivered HEAD, clean raw files/index and unchanged instructions',
      );
    }
  }

  /**
   * Resumes the provider conversation of a settled execution of the same role, version, slice,
   * workspace and provider when the context policy allows; otherwise records why it starts fresh.
   * Either way the decision is journaled on the session and the task.
   */
  private continueSession(input: Continuation): void {
    const { session, resumeFrom, task, version, role, model } = input;
    const previous = this.get(resumeFrom),
      prior = new Sessions(this.store).get(previous.sessionId);
    if (!resumable(previous, prior, input))
      throw new Error(
        'Session continuation requires a settled execution of the same role, version, slice, workspace and provider',
      );
    const decision = sessionContinuation(this.store, prior, task.guided?.plan.workflowPolicy);
    // A provider conversation keeps its model and tool mode, so a different choice needs a fresh one.
    if (
      (model !== null && prior.model !== model) ||
      prior.effort !== session.effort ||
      (role === 'implementation' && prior.mode !== 'editing')
    ) {
      decision.resume = false;
      decision.reason = 'Start fresh for the selected model or editing mode';
    }
    if (decision.resume) {
      session.providerSessionId = prior.providerSessionId;
      session.model = prior.model;
      if (prior.mode) session.mode = prior.mode;
      if (prior.toolsetVersion !== undefined) session.toolsetVersion = prior.toolsetVersion;
    }
    this.store.saveSession(session.id, session);
    this.store.appendSession(session.id, decision.resume ? 'session.continued' : 'session.context_reset', {
      from: prior.id,
      ...decision,
    });
    this.store.append(task.id, version, decision.resume ? 'agent.session_continued' : 'agent.context_reset', {
      role,
      sessionId: session.id,
      from: prior.id,
      ...decision,
    });
  }

  /** The new execution record; its usage stage is decided once, here. */
  private newExecution(
    task: Task,
    attempt: Attempt,
    options: ExecutionOptions,
    binding: { workspaceId: string; sessionId: string; inspected: Inspected },
  ): Execution {
    const role = options.role ?? 'implementation';
    const sliceIndex = task.slice?.index ?? 0;
    // A revision starts every attempt fresh, so only this version's earlier attempts make this a repair.
    const repeated = this.store
      .executions(task.id)
      .some(item => item.version === task.version && item.role === 'implementation' && item.sliceIndex === sliceIndex);
    return {
      stage:
        role === 'review' ? (options.arbitration ? 'arbitration' : 'review') : repeated ? 'repair' : 'implementation',
      id: randomUUID(),
      taskId: task.id,
      version: task.version,
      attemptId: attempt.id,
      sliceIndex,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      role,
      phase: 'open',
      headAtCreation: binding.inspected.head,
      artifact: role === 'review' ? attempt.artifact : null,
      fallbackReason: options.fallbackReason ?? null,
    };
  }

  /**
   * Closes an idle execution. Closing the running implementation attempt also stops it, because every
   * session turn has already settled with a confirmed process exit.
   */
  close(id: string): void {
    this.store.transaction(() => {
      const execution = this.get(id);
      if (execution.phase === 'closed') throw new Error('Execution is already closed');
      assertTaskExecutionIdle(this.store, execution.taskId);
      const session = new Sessions(this.store).get(execution.sessionId);
      if (session.run) throw new Error('Reconcile the session before closing its execution');
      const workflow = new Workflow(this.store);
      const task = workflow.get(execution.taskId);
      if (execution.role === 'implementation' && task.attempt?.id === execution.attemptId && task.phase === 'running') {
        workflow.requestStop(task.id);
        workflow.confirmStopped(
          task.id,
          execution.attemptId,
          'Execution closed while idle; all session turns settled with confirmed process exit',
        );
      }
      execution.phase = 'closed';
      this.store.saveExecution(id, execution.taskId, execution.workspaceId, execution.sessionId, execution);
      this.store.appendExecution(id, 'execution.closed', {});
      this.store.append(execution.taskId, execution.version, 'execution.closed', { executionId: id });
    });
  }
}
