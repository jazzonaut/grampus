import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { Sessions } from './sessions.js';
import { Workspaces } from './workspaces.js';
import type { Provider } from './agents/types.js';
import { assertTaskExecutionIdle, type Execution } from './execution-state.js';

export class Executions {
  constructor(private readonly store: Store, private readonly workspaces = new Workspaces(store)) {}
  get(id: string): Execution { return this.store.execution<Execution>(id); }
  list(): Execution[] { return this.store.executions<Execution>(); }

  async create(workspaceId: string, version: number, provider: Provider, role: Execution['role'] = 'implementation',
    model: string | null = null, fallbackReason: string | null = null): Promise<Execution> {
    if (!['implementation', 'review'].includes(role)) throw new Error('Execution role must be implementation or review');
    const inspected = await this.workspaces.inspect(workspaceId);
    return this.store.transaction(() => {
      const workspace = this.workspaces.get(workspaceId);
      const workflow = new Workflow(this.store);
      const task = workflow.get(workspace.taskId);
      if (workspace.phase !== 'ready' || !workspace.path || workspace.version !== version
        || task.version !== version || task.approvedVersion !== version || !inspected.taskCurrent) {
        throw new Error('Execution requires the exact approved task and ready workspace version');
      }
      assertTaskExecutionIdle(this.store, task.id);
      if (task.synthetic) throw new Error('Synthetic tasks cannot create executions');
      if (role === 'review') {
        if (!['awaiting_verification', 'awaiting_decision'].includes(task.phase) || task.attempt?.outcome !== 'succeeded') {
          throw new Error('Review requires a successful current attempt');
        }
        if (task.attempt.agent.provider === provider && !fallbackReason?.trim()) throw new Error('Same-provider review requires a fallback reason');
      }
      const session = new Sessions(this.store).create(provider, workspace.path, model);
      const attempt = role === 'implementation'
        ? workflow.start(task.id, { provider, model: model ?? 'provider-default', sessionId: session.id })
        : task.attempt!;
      const execution: Execution = { id: randomUUID(), taskId: task.id, version, attemptId: attempt.id,
        workspaceId, sessionId: session.id, role, phase: 'open', headAtCreation: inspected.head,
        artifact: role === 'review' ? attempt.artifact : null, fallbackReason };
      this.store.saveExecution(execution.id, task.id, workspaceId, session.id, execution);
      this.store.appendExecution(execution.id, 'execution.created', execution);
      this.store.append(task.id, version, 'execution.created', execution);
      this.store.appendSession(session.id, 'execution.linked', { executionId: execution.id, taskId: task.id, version, attemptId: attempt.id, workspaceId, role });
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
        workflow.confirmStopped(task.id, execution.attemptId, 'Execution closed while idle; all session turns settled with confirmed process exit');
      }
      execution.phase = 'closed';
      this.store.saveExecution(id, execution.taskId, execution.workspaceId, execution.sessionId, execution);
      this.store.appendExecution(id, 'execution.closed', {});
      this.store.append(execution.taskId, execution.version, 'execution.closed', { executionId: id });
    });
  }
}
