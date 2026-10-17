import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Session } from './sessions.js';
import type { Task } from './workflow.js';
import type { Workspace } from './workspaces.js';
import { Store } from './store.js';

export interface Execution {
  id: string;
  taskId: string;
  version: number;
  attemptId: string;
  workspaceId: string;
  sessionId: string;
  role: 'implementation' | 'review';
  phase: 'open' | 'closed';
  headAtCreation: string;
  artifact: string | null;
  fallbackReason: string | null;
}

export interface ExecutionLease {
  executionId: string;
  sessionId: string;
  runId: string;
  controllerPid: number;
  host: string;
  kind?: 'conversation' | 'snapshot' | 'check' | 'submission' | 'simplification' | 'verification' | 'completion';
  readOnlyRecovery?: true;
}

function canonical(path: string, allowMissing = false): string {
  let value: string;
  try { value = realpathSync.native(path); }
  catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    value = resolve(path);
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function assertTaskExecutionIdle(store: Store, taskId: string): void {
  if (store.workspaces<Workspace>().some(workspace => workspace.taskId === taskId && store.lease(workspace.id))) {
    throw new Error('Workspace has an active or uncertain execution lease');
  }
}

/** Called within an ownership transaction, before any provider or command dispatch. */
export function claimExecution(store: Store, session: Session, runId: string, kind: NonNullable<ExecutionLease['kind']> = 'conversation'): void {
  const execution = store.executionForSession<Execution>(session.id);
  if (!execution) {
    const cwd = canonical(session.cwd);
    for (const workspace of store.workspaces<Workspace>()) {
      if (!workspace.path || workspace.host !== hostname()) continue;
      const part = relative(canonical(workspace.path, true), cwd);
      if (part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))) {
        throw new Error('Use an execution-linked session inside a managed workspace');
      }
    }
    return;
  }
  const task = store.get<Task>(execution.taskId);
  const workspace = store.workspace<Workspace>(execution.workspaceId);
  if (execution.phase !== 'open' || execution.version !== task.version || task.approvedVersion !== execution.version
    || task.attempt?.id !== execution.attemptId) throw new Error('Execution is closed or belongs to an outdated task attempt');
  if (workspace.phase !== 'ready' || workspace.host !== hostname() || workspace.taskId !== task.id
    || workspace.version !== execution.version || !workspace.path || canonical(workspace.path) !== canonical(session.cwd)) {
    throw new Error('Execution workspace identity or version does not match');
  }
  if (execution.role === 'implementation') {
    const submitted = ['snapshot', 'simplification', 'verification', 'completion'].includes(kind)
      && ['awaiting_verification', 'awaiting_decision'].includes(task.phase) && task.attempt.outcome === 'succeeded';
    if ((!submitted && (task.phase !== 'running' || task.attempt.outcome !== 'running')) || task.attempt.agent.sessionId !== session.id) {
      throw new Error('Implementation attempt is settled; create a fresh execution attempt');
    }
  } else if (!['awaiting_verification', 'awaiting_decision'].includes(task.phase)
    || task.attempt.outcome !== 'succeeded' || task.attempt.artifact !== execution.artifact) {
    throw new Error('Review no longer matches the current successful artifact');
  }
  if (store.lease(workspace.id)) throw new Error('Workspace already has an active or uncertain execution lease');
  const directory = canonical(workspace.path);
  if (store.sessions<Session>().some(other => {
    if (other.id === session.id || !other.run) return false;
    if (other.run.host !== hostname()) return false;
    const part = relative(directory, canonical(other.cwd, true));
    return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  })) throw new Error('Workspace has another active or uncertain session; reconcile it first');
  const lease: ExecutionLease = { executionId: execution.id, sessionId: session.id, runId, controllerPid: process.pid, host: hostname(), kind,
    ...(['snapshot', 'submission', 'simplification', 'completion'].includes(kind) ? { readOnlyRecovery: true as const } : {}) };
  store.acquireLease(workspace.id, execution.id, runId, lease);
  store.appendExecution(execution.id, 'lease.acquired', lease);
  store.append(task.id, task.version, kind === 'conversation' ? 'execution.turn_requested' : 'execution.operation_requested', { executionId: execution.id, sessionId: session.id, runId, role: execution.role, kind });
}

export function requireExecutionLease(store: Store, session: Session, runId: string): Execution | null {
  const execution = store.executionForSession<Execution>(session.id);
  if (!execution) return null;
  const lease = store.lease<ExecutionLease>(execution.workspaceId);
  if (lease?.executionId !== execution.id || lease.runId !== runId || lease.sessionId !== session.id) {
    throw new Error('Execution lease no longer matches this run');
  }
  return execution;
}

export function stopExecution(store: Store, session: Session, runId: string, reason: string): void {
  const execution = requireExecutionLease(store, session, runId);
  if (!execution) return;
  store.appendExecution(execution.id, 'stop.requested', { runId, reason });
  const task = store.get<Task>(execution.taskId);
  if (execution.role === 'implementation' && task.attempt?.id === execution.attemptId && task.phase === 'running') {
    task.phase = 'stop_requested';
    store.save(task.id, task);
    store.append(task.id, task.version, 'stop.requested', { attemptId: execution.attemptId, executionId: execution.id, reason });
  }
}

/** Session state, task outcome and lease release are one transaction; replies are not task success. */
export function settleExecution(store: Store, session: Session, runId: string,
  outcome: 'completed' | 'failed' | 'interrupted', exitConfirmed: boolean): void {
  const execution = requireExecutionLease(store, session, runId);
  if (!execution) return;
  const task = store.get<Task>(execution.taskId);
  const current = task.version === execution.version && task.attempt?.id === execution.attemptId;
  if (current && execution.role === 'implementation') {
    if (!exitConfirmed) { task.phase = 'recovery_required'; task.attempt!.outcome = 'uncertain'; }
    else if (outcome === 'interrupted' || task.phase === 'stop_requested') { task.phase = 'stopped'; task.attempt!.outcome = 'stopped'; }
    else if (outcome === 'failed') { task.phase = 'failed'; task.attempt!.outcome = 'failed'; }
    store.save(task.id, task);
  }
  store.appendExecution(execution.id, exitConfirmed ? 'turn.settled' : 'recovery.required', { runId, outcome, exitConfirmed, current });
  store.append(task.id, task.version, 'execution.turn_settled', { executionId: execution.id, attemptId: execution.attemptId, runId, outcome, exitConfirmed, current });
  if (exitConfirmed) {
    store.releaseLease(execution.workspaceId, execution.id, runId);
    store.appendExecution(execution.id, 'lease.released', { runId });
  }
}
