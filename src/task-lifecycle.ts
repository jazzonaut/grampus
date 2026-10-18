import { Store } from './store.js';
import { Kickoffs } from './kickoff.js';
import { GuidedTasks, guidedDecisionKey, guidedQuestionKey } from './guided-tasks.js';
import { assertTaskExecutionIdle, type Execution } from './execution-state.js';
import type { Task } from './workflow.js';
import type { Workspace } from './workspaces.js';
import type { Session } from './sessions.js';

/** Dashboard deletion is a tombstone, not filesystem cleanup or erased evidence. */
export class TaskLifecycle {
  constructor(private readonly store: Store) {}
  private idle(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    if (kind === 'kickoffs') {
      const view = new Kickoffs(this.store).view(id);
      if (view.session.deletedAt || view.taskId) throw new Error('Manage the current task instead of its converted planning conversation');
      if (view.turnKey !== expected) throw new Error('Planning state changed; refresh before managing this task');
      if (view.session.run || ['running', 'stop_requested', 'recovery_required'].includes(view.session.phase)) throw new Error('Stop the planner and confirm settlement or recovery first');
      return;
    }
    const task = this.store.get<Task>(id), state = new GuidedTasks(this.store).get(id);
    if (task.deletedAt) throw new Error('Task was already deleted');
    if (expected !== guidedDecisionKey(state, guidedQuestionKey(this.store, state))) throw new Error('Task changed; refresh before managing it');
    if (state.owner || state.pending || state.status === 'recovery_required' || ['stop_requested', 'recovery_required'].includes(task.phase)) throw new Error('Stop the task and confirm settlement or recovery first');
    assertTaskExecutionIdle(this.store, id);
    if (this.store.executions<Execution>().some(execution => execution.taskId === id && this.store.session<Session>(execution.sessionId).run)) throw new Error('An agent still owns a session; stop or recover it first');
    if (this.store.workspaces<Workspace>().some(workspace => workspace.taskId === id && (workspace.owner || !['ready', 'released'].includes(workspace.phase)))) throw new Error('Recover workspace creation before managing the task');
  }
  private hide(kind: 'tasks' | 'kickoffs', id: string, resetTo?: string) {
    const deletedAt = new Date().toISOString();
    if (kind === 'tasks') {
      const task = this.store.get<Task>(id); task.deletedAt = deletedAt; task.approvedVersion = null;
      if (task.phase !== 'complete') { task.phase = 'stopped'; if (task.attempt?.outcome === 'running') task.attempt.outcome = 'stopped'; }
      if (resetTo) task.resetTo = resetTo;
      this.store.save(id, task); this.store.append(id, task.version, resetTo ? 'task.reset' : 'task.deleted', { deletedAt, resetTo, retained: 'Workspace files, commits and journal evidence' });
    } else {
      const session = this.store.session<Session>(id); session.deletedAt = deletedAt;
      this.store.saveSession(id, session); this.store.appendSession(id, resetTo ? 'kickoff.reset' : 'kickoff.deleted', { deletedAt, resetTo });
    }
  }
  delete(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    return this.store.transaction(() => { this.idle(kind, id, expected); this.hide(kind, id); return { ok: true }; });
  }
  reset(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    return this.store.transaction(() => {
      this.idle(kind, id, expected);
      const kickoffs = new Kickoffs(this.store);
      const task = kind === 'tasks' ? this.store.get<Task>(id) : null;
      const source = kind === 'kickoffs' ? kickoffs.view(id) : kickoffs.list().find(view => view.taskId === id);
      const plan = task?.guided?.plan;
      const repo = source?.config.repo ?? plan!.workspace.repo;
      const request = source?.config.request ?? `${task!.brief.title}\n${task!.brief.outcome}\n${task!.brief.criteria.join('\n')}`;
      const references = source?.config.references ?? plan?.references ?? [];
      const fresh = kickoffs.create({ repo, request, provider: source?.config.provider ?? plan!.implementation.provider,
        adapter: source?.config.adapter ?? plan!.workspace.adapter, timeoutMs: source?.config.timeoutMs ?? plan?.implementation.timeoutMs ?? 300000,
        references: references.map(reference => reference.path) });
      this.hide(kind, id, fresh);
      this.store.appendSession(fresh, 'kickoff.reset_from', { kind, id });
      return { id: fresh };
    });
  }
}
