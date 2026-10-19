import { randomUUID } from 'node:crypto';
import type { Store } from '../persistence/store.js';
import { Workflow } from '../domain/workflow.js';
import { Sessions } from './sessions.js';
import { Workspaces } from '../repository/workspaces.js';
import type { Provider } from '../providers/types.js';
import { assertTaskExecutionIdle, type Execution } from './execution-state.js';
import { requireDeadController } from '../verification/check-recovery.js';
import { snapshotRepository, type RepositorySnapshot } from '../repository/artifacts.js';
import { verifyNoChange } from '../repository/delivery-git.js';
import { sessionContinuation } from './session-context.js';

export class Executions {
  constructor(
    private readonly store: Store,
    private readonly workspaces = new Workspaces(store),
  ) {}
  get(id: string): Execution {
    return this.store.execution(id);
  }
  list(): Execution[] {
    return this.store.executions();
  }

  recoverReadOnly(id: string): void {
    this.store.transaction(() => {
      const execution = this.get(id);
      const lease = this.store.lease(execution.workspaceId);
      if (
        lease?.executionId !== id ||
        !lease.readOnlyRecovery ||
        !['snapshot', 'submission', 'simplification', 'completion'].includes(lease.kind)
      ) {
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
   * Binds the current attempt to a fresh session in `role`. The execution's usage stage is fixed here:
   * an implementation is `repair` when the task already has an implementation execution for this
   * slice, and a review is `arbitration` when the caller says it arbitrates.
   */
  async create(
    workspaceId: string,
    version: number,
    provider: Provider,
    role: Execution['role'] = 'implementation',
    model: string | null = null,
    fallbackReason: string | null = null,
    resumeFrom: string | null = null,
    arbitration = false,
  ): Promise<Execution> {
    if (!['implementation', 'review'].includes(role))
      throw new Error('Execution role must be implementation or review');
    const inspected = await this.workspaces.inspect(workspaceId);
    const observedTask = new Workflow(this.store).get(inspected.workspace.taskId);
    let continuation: RepositorySnapshot | null = null;
    if (role === 'implementation' && observedTask.phase === 'ready' && observedTask.slice?.completed.length) {
      const workspace = inspected.workspace;
      const path = workspace.path;
      if (!path) throw new Error('Workspace has no path');
      continuation = await snapshotRepository(path, workspace.baseCommit);
      const revision = observedTask.guided?.plan.revision;
      const revisedContinuation =
        revision &&
        revision.sliceIndex === observedTask.slice.index &&
        revision.artifact === continuation.artifact &&
        revision.head === continuation.head &&
        revision.instructionsDigest === continuation.instructionsDigest;
      if (!revisedContinuation)
        verifyNoChange({
          id: 'continuation',
          cwd: path,
          branch: `refs/heads/${workspace.branch}`,
          base: workspace.baseCommit,
          message: 'Verify slice continuation',
          snapshot: continuation,
        });
      const again = await snapshotRepository(path, workspace.baseCommit);
      if (again.artifact !== continuation.artifact)
        throw new Error('Repository changed while checking slice continuation');
    }
    return this.store.transaction(() => {
      const workspace = this.workspaces.get(workspaceId);
      const workflow = new Workflow(this.store);
      const task = workflow.get(workspace.taskId);
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
      const previous = task.slice?.completed.at(-1);
      if (role === 'implementation' && previous) {
        if (inspected.head !== previous.head) throw new Error('HEAD differs from the last delivered slice');
        if (task.phase === 'ready') {
          const delivery = this.store.delivery(previous.deliveryId);
          const revised = task.guided?.plan.revision;
          const approvedRevision =
            revised &&
            revised.sliceIndex === task.slice?.index &&
            continuation &&
            revised.artifact === continuation.artifact &&
            revised.head === continuation.head &&
            revised.instructionsDigest === continuation.instructionsDigest;
          if (
            !continuation ||
            continuation.head !== previous.head ||
            (!approvedRevision && continuation.instructionsDigest !== delivery.spec.instructionsDigest)
          ) {
            throw new Error(
              'Slice continuation requires the last delivered HEAD, clean raw files/index and unchanged instructions',
            );
          }
        }
      }
      if (role === 'review') {
        if (
          !['awaiting_verification', 'awaiting_decision'].includes(task.phase) ||
          task.attempt?.outcome !== 'succeeded'
        ) {
          throw new Error('Review requires a successful current attempt');
        }
        if (task.attempt.agent.provider === provider && !fallbackReason?.trim())
          throw new Error('Same-provider review requires a fallback reason');
      }
      const session = new Sessions(this.store).create(provider, workspace.path, model);
      if (resumeFrom) {
        const previous = this.get(resumeFrom),
          prior = new Sessions(this.store).get(previous.sessionId);
        if (
          previous.taskId !== task.id ||
          previous.version !== version ||
          previous.workspaceId !== workspaceId ||
          previous.role !== role ||
          previous.sliceIndex !== (task.slice?.index ?? 0) ||
          previous.phase !== 'closed' ||
          prior.provider !== provider ||
          prior.run ||
          ['running', 'stop_requested', 'recovery_required', 'awaiting_answer'].includes(prior.phase)
        )
          throw new Error(
            'Session continuation requires a settled execution of the same role, version, slice, workspace and provider',
          );
        const decision = sessionContinuation(this.store, prior, task.guided?.plan.workflowPolicy);
        if ((model !== null && prior.model !== model) || (role === 'implementation' && prior.mode !== 'editing')) {
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
      const attempt =
        role === 'implementation'
          ? workflow.start(task.id, { provider, model: model ?? 'provider-default', sessionId: session.id })
          : task.attempt;
      if (!attempt) throw new Error('Review requires an implementation attempt');
      const sliceIndex = task.slice?.index ?? 0;
      const execution: Execution = {
        stage:
          role === 'review'
            ? arbitration
              ? 'arbitration'
              : 'review'
            : this.store
                  .executions()
                  .some(
                    item => item.taskId === task.id && item.role === 'implementation' && item.sliceIndex === sliceIndex,
                  )
              ? 'repair'
              : 'implementation',
        id: randomUUID(),
        taskId: task.id,
        version,
        attemptId: attempt.id,
        sliceIndex,
        workspaceId,
        sessionId: session.id,
        role,
        phase: 'open',
        headAtCreation: inspected.head,
        artifact: role === 'review' ? attempt.artifact : null,
        fallbackReason,
      };
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
