// Owns execution leases: the single current owner of a workspace for one turn or operation, claimed
// before dispatch, fenced on its run id for every journaled effect and released only once the process
// exit is confirmed. There is no expiry; an uncertain owner stays until explicit recovery.
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Session } from './sessions.js';
import type { Store } from '../persistence/store.js';
import { currentProcessStartedAt } from '../process/process-identity.js';
import type { Execution, ExecutionLease, Workspace } from '../persistence/records.js';
import type { Attempt, Task } from '../domain/workflow.js';
import { systemErrorCode } from '../process/boundary.js';

export type { Execution, ExecutionLease } from '../persistence/records.js';

/**
 * The real path for comparison, lower-cased on Windows where paths are case-insensitive. With
 * `allowMissing`, a path that does not exist falls back to its resolved form.
 */
function canonical(path: string, allowMissing = false): string {
  let value: string;
  try {
    value = realpathSync.native(path);
  } catch (error) {
    if (!allowMissing || systemErrorCode(error) !== 'ENOENT') throw error;
    value = resolve(path);
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Throws if any workspace of the task holds a lease: an operation may still be running or need
 * recovery, so no state change may assume the task is idle.
 */
export function assertTaskExecutionIdle(store: Store, taskId: string): void {
  if (store.workspaces().some(workspace => workspace.taskId === taskId && store.lease(workspace.id))) {
    throw new Error('Workspace has an active or uncertain execution lease');
  }
}

/** Whether `child` is `parent` or inside it (both canonical). */
function within(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/**
 * A session without an execution (a planning conversation) may not run inside a managed workspace on
 * this host: work there must go through an execution so it is bound to an attempt and leased.
 */
function requireOutsideManagedWorkspaces(store: Store, session: Session): void {
  const cwd = canonical(session.cwd);
  for (const workspace of store.workspaces()) {
    if (workspace.phase === 'released' || !workspace.path || workspace.host !== hostname()) continue;
    if (within(canonical(workspace.path, true), cwd))
      throw new Error('Use an execution-linked session inside a managed workspace');
  }
}

/**
 * Throws unless the execution's attempt may still act: an implementation turn needs its running
 * attempt in this session (or, for read-only and delivery operations, the submitted successful
 * attempt); a review needs the current successful attempt on the artifact it was created for.
 */
function requireActionableAttempt(
  task: Task,
  attempt: Attempt,
  execution: Execution,
  session: Session,
  kind: ExecutionLease['kind'],
): void {
  const submitted =
    ['awaiting_verification', 'awaiting_decision'].includes(task.phase) && attempt.outcome === 'succeeded';
  if (execution.role === 'implementation') {
    const operatesOnSubmission = ['snapshot', 'assessment', 'verification', 'completion', 'delivery'].includes(kind);
    if (
      (!(operatesOnSubmission && submitted) && (task.phase !== 'running' || attempt.outcome !== 'running')) ||
      attempt.agent.sessionId !== session.id
    ) {
      throw new Error('Implementation attempt is settled; create a fresh execution attempt');
    }
  } else if (!submitted || attempt.artifact !== execution.artifact) {
    throw new Error('Review no longer matches the current successful artifact');
  }
}

/** The execution, its approved task version and attempt, and its workspace on this host all still match. */
function requireCurrentBinding(
  store: Store,
  execution: Execution,
  session: Session,
): { task: Task; attempt: Attempt; workspace: Workspace; directory: string } {
  const task = store.get(execution.taskId);
  const workspace = store.workspace(execution.workspaceId);
  const attempt = task.attempt;
  if (
    execution.phase !== 'open' ||
    execution.version !== task.version ||
    task.approvedVersion !== execution.version ||
    attempt?.id !== execution.attemptId
  )
    throw new Error('Execution is closed or belongs to an outdated task attempt');
  if (
    workspace.phase !== 'ready' ||
    workspace.host !== hostname() ||
    workspace.taskId !== task.id ||
    workspace.version !== execution.version ||
    !workspace.path ||
    canonical(workspace.path) !== canonical(session.cwd)
  ) {
    throw new Error('Execution workspace identity or version does not match');
  }
  return { task, attempt, workspace, directory: canonical(workspace.path) };
}

/**
 * Claims the session's workspace for one run (a provider turn or an operation of `kind`) by acquiring
 * its single lease, after proving the execution is current and nothing else is active in that
 * workspace. Call within an ownership transaction, before any provider or command dispatch. Leases
 * of read-only kinds are marked so a dead owner can be released without reconciliation.
 */
export function claimExecution(
  store: Store,
  session: Session,
  runId: string,
  kind: ExecutionLease['kind'] = 'conversation',
): void {
  const execution = store.executionForSession(session.id);
  if (!execution) {
    requireOutsideManagedWorkspaces(store, session);
    return;
  }
  const { task, attempt, workspace, directory } = requireCurrentBinding(store, execution, session);
  requireActionableAttempt(task, attempt, execution, session, kind);
  if (store.lease(workspace.id)) throw new Error('Workspace already has an active or uncertain execution lease');
  // Any other session with an active or uncertain run inside this workspace would share its files.
  if (
    store.sessions().some(other => {
      if (other.id === session.id || !other.run) return false;
      if (other.run.host !== hostname()) return false;
      return within(directory, canonical(other.cwd, true));
    })
  )
    throw new Error('Workspace has another active or uncertain session; reconcile it first');
  const lease: ExecutionLease = {
    executionId: execution.id,
    sessionId: session.id,
    runId,
    controllerPid: process.pid,
    controllerStartedAt: currentProcessStartedAt(),
    host: hostname(),
    kind,
    ...(['snapshot', 'submission', 'assessment', 'completion'].includes(kind)
      ? { readOnlyRecovery: true as const }
      : {}),
  };
  store.acquireLease(workspace.id, execution.id, runId, lease);
  store.appendExecution(execution.id, 'lease.acquired', lease);
  store.append(
    task.id,
    task.version,
    kind === 'conversation' ? 'execution.turn_requested' : 'execution.operation_requested',
    { executionId: execution.id, sessionId: session.id, runId, role: execution.role, kind },
  );
}

/**
 * The session's execution, after proving the run still holds its workspace lease; null for a
 * session without an execution. Every journaled effect of a run is fenced on this.
 */
export function requireExecutionLease(store: Store, session: Session, runId: string): Execution | null {
  const execution = store.executionForSession(session.id);
  if (!execution) return null;
  const lease = store.lease(execution.workspaceId);
  if (lease?.executionId !== execution.id || lease.runId !== runId || lease.sessionId !== session.id) {
    throw new Error('Execution lease no longer matches this run');
  }
  return execution;
}

/**
 * Journals a stop request for the run's execution and, for the running implementation attempt, moves the
 * task to `stop_requested`. Only the record changes; the lease stays until the exit is confirmed.
 *
 * @throws Error when the run no longer holds its execution lease.
 */
export function stopExecution(store: Store, session: Session, runId: string, reason: string): void {
  const execution = requireExecutionLease(store, session, runId);
  if (!execution) return;
  store.appendExecution(execution.id, 'stop.requested', { runId, reason });
  const task = store.get(execution.taskId);
  if (execution.role === 'implementation' && task.attempt?.id === execution.attemptId && task.phase === 'running') {
    task.phase = 'stop_requested';
    store.save(task.id, task);
    store.append(task.id, task.version, 'stop.requested', {
      attemptId: execution.attemptId,
      executionId: execution.id,
      reason,
    });
  }
}

/**
 * Session state, task outcome and lease release are one transaction; replies are not task success.
 * Call inside the session's settling transaction. A completed turn leaves the attempt running, because
 * a reply is not task success; an unconfirmed exit makes it uncertain and keeps the lease. A turn
 * for an outdated version or attempt is journaled with `current: false` and changes no task state.
 *
 * @throws Error when the run no longer holds its execution lease.
 */
export function settleExecution(
  store: Store,
  session: Session,
  runId: string,
  outcome: 'completed' | 'failed' | 'interrupted',
  exitConfirmed: boolean,
): void {
  const execution = requireExecutionLease(store, session, runId);
  if (!execution) return;
  const task = store.get(execution.taskId);
  const attempt = task.attempt;
  const current = task.version === execution.version && attempt?.id === execution.attemptId;
  if (current && attempt && execution.role === 'implementation') {
    if (!exitConfirmed) {
      task.phase = 'recovery_required';
      attempt.outcome = 'uncertain';
    } else if (outcome === 'interrupted' || task.phase === 'stop_requested') {
      task.phase = 'stopped';
      attempt.outcome = 'stopped';
    } else if (outcome === 'failed') {
      task.phase = 'failed';
      attempt.outcome = 'failed';
    }
    store.save(task.id, task);
  }
  store.appendExecution(execution.id, exitConfirmed ? 'turn.settled' : 'recovery.required', {
    runId,
    outcome,
    exitConfirmed,
    current,
  });
  store.append(task.id, task.version, 'execution.turn_settled', {
    executionId: execution.id,
    attemptId: execution.attemptId,
    runId,
    outcome,
    exitConfirmed,
    current,
  });
  if (exitConfirmed) {
    store.releaseLease(execution.workspaceId, execution.id, runId);
    store.appendExecution(execution.id, 'lease.released', { runId });
  }
}
