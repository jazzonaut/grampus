// Owns dashboard task management: deleting or resetting a task or planning conversation. Both are
// tombstones that hide the item; workspace files, commits and journal evidence are always retained,
// and deletion/reset refuse live or uncertain work. Explicit discard preserves uncertain outcomes.
import type { Store } from '../persistence/store.js';
import type { Task } from '../domain/workflow.js';
import { Kickoffs } from './kickoff.js';
import { GuidedTasks } from './guided/controller.js';
import { guidedDecisionKey, guidedQuestionKey } from './guided/keys.js';
import { assertTaskExecutionIdle } from '../execution/execution-state.js';
import { discardTask } from './task-discard.js';

/** What a reset kickoff starts from. */
type ResetSource = Parameters<Kickoffs['create']>[0];

/** A fresh kickoff for a task that has no planning conversation, rebuilt from its guided plan. */
function taskResetSource(task: Task): ResetSource {
  const plan = task.guided?.plan;
  if (!plan) throw new Error('Only a guided task can be reset into a new planning conversation');
  return {
    repo: plan.workspace.repo,
    request: [task.brief.title, task.brief.outcome, ...task.brief.criteria].join('\n'),
    provider: plan.implementation.provider,
    adapter: plan.workspace.adapter,
    references: (plan.references ?? []).map(reference => reference.path),
  };
}

/** Dashboard deletion is a tombstone, not filesystem cleanup or erased evidence. */
export class TaskLifecycle {
  constructor(private readonly store: Store) {}

  /**
   * Throws unless the item matches the state the person inspected (`expected`) and nothing is running
   * or uncertain: no runner owner, pending step, held lease, live session or unfinished workspace.
   */
  private idle(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    if (kind === 'kickoffs') {
      const view = new Kickoffs(this.store).view(id);
      if (view.session.deletedAt || view.taskId)
        throw new Error('Manage the current task instead of its converted planning conversation');
      if (view.turnKey !== expected) throw new Error('Planning state changed; refresh before managing this task');
      if (view.session.run || ['running', 'stop_requested', 'recovery_required'].includes(view.session.phase))
        throw new Error('Stop the planner and confirm settlement or recovery first');
      return;
    }
    const task = this.store.get(id),
      state = new GuidedTasks(this.store).get(id);
    if (task.deletedAt) throw new Error('Task was already deleted');
    if (expected !== guidedDecisionKey(state, guidedQuestionKey(this.store, state)))
      throw new Error('Task changed; refresh before managing it');
    if (
      state.owner ||
      state.pending ||
      state.status === 'recovery_required' ||
      ['stop_requested', 'recovery_required'].includes(task.phase)
    )
      throw new Error('Stop the task and confirm settlement or recovery first');
    assertTaskExecutionIdle(this.store, id);
    if (
      this.store.executions().some(execution => execution.taskId === id && this.store.session(execution.sessionId).run)
    )
      throw new Error('An agent still owns a session; stop or recover it first');
    if (
      this.store
        .workspaces()
        .some(
          workspace => workspace.taskId === id && (workspace.owner || !['ready', 'released'].includes(workspace.phase)),
        )
    )
      throw new Error('Recover workspace creation before managing the task');
  }

  /** Writes the tombstone; a reset also records the kickoff that replaces the item. */
  private hide(kind: 'tasks' | 'kickoffs', id: string, resetTo?: string) {
    const deletedAt = new Date().toISOString();
    if (kind === 'tasks') {
      const task = this.store.get(id);
      task.deletedAt = deletedAt;
      // The tombstone also withdraws approval, so no earlier approval can start the hidden task.
      task.approvedVersion = null;
      if (task.phase !== 'complete') {
        task.phase = 'stopped';
        if (task.attempt?.outcome === 'running') task.attempt.outcome = 'stopped';
      }
      if (resetTo) task.resetTo = resetTo;
      this.store.save(id, task);
      this.store.append(id, task.version, resetTo ? 'task.reset' : 'task.deleted', {
        deletedAt,
        resetTo,
        retained: 'Workspace files, commits and journal evidence',
      });
    } else {
      const session = this.store.session(id);
      session.deletedAt = deletedAt;
      this.store.saveSession(id, session);
      this.store.appendSession(id, resetTo ? 'kickoff.reset' : 'kickoff.deleted', { deletedAt, resetTo });
    }
  }

  /**
   * Deletes an idle task or planning conversation (a tombstone). `expected` is the decision key (task)
   * or turn key (kickoff) the person inspected; throws, changing nothing, unless the item is idle.
   */
  delete(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    return this.store.transaction(() => {
      this.idle(kind, id, expected);
      this.hide(kind, id);
      return { ok: true };
    });
  }

  /** Explicitly abandons a recovery task, preserving its uncertain outcomes and workspace locks. */
  discard(id: string, expected: string): { ok: true } {
    return discardTask(this.store, id, expected);
  }

  /**
   * Replaces an idle item with a fresh planning conversation for the same request, then hides the
   * original. The new kickoff starts from the original conversation when there is one, otherwise from
   * the task's plan. Returns the new kickoff id. Creation and the tombstone commit together, so a
   * failed reset leaves the original visible; throws under the same rules as {@link TaskLifecycle.delete}.
   */
  reset(kind: 'tasks' | 'kickoffs', id: string, expected: string) {
    return this.store.transaction(() => {
      this.idle(kind, id, expected);
      const kickoffs = new Kickoffs(this.store);
      const source = kind === 'kickoffs' ? kickoffs.view(id) : kickoffs.list().find(view => view.taskId === id);
      const fresh = kickoffs.create(
        source
          ? {
              repo: source.config.repo,
              request: source.config.request,
              provider: source.config.provider,
              adapter: source.config.adapter,
              references: source.config.references.map(reference => reference.path),
            }
          : taskResetSource(this.store.get(id)),
      );
      this.hide(kind, id, fresh);
      this.store.appendSession(fresh, 'kickoff.reset_from', { kind, id });
      return { id: fresh };
    });
  }
}
