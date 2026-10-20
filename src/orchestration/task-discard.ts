// Owns explicit abandonment of recovery-blocked tasks. Hiding a task never settles its operation:
// uncertain outcomes, workspace leases, files and receipts remain available for forensic recovery.
import { hostname } from 'node:os';
import type { Store } from '../persistence/store.js';
import { StaleStateError } from '../persistence/errors.js';
import { deepEqual } from '../domain/deep-equal.js';
import { processAlive } from '../verification/check-recovery.js';
import { guidedDecisionKey, guidedQuestionKey } from './guided/keys.js';
import type { Owner } from './guided/state.js';
import { changeComparison } from './comparisons.js';

type Controller = Pick<Owner, 'host' | 'controllerPid' | 'controllerStartedAt'>;

/** Captures ownership as well as the decision, since owner changes do not change the decision key. */
function discardSnapshot(store: Store, id: string) {
  return {
    task: store.get(id),
    workspaces: store
      .workspaces()
      .filter(workspace => workspace.taskId === id)
      .map(workspace => ({ workspace, lease: store.lease(workspace.id) })),
    sessions: store
      .executions()
      .filter(execution => execution.taskId === id)
      .map(execution => store.session(execution.sessionId)),
    comparisons: store.comparisons().filter(group => group.runs.some(run => run.taskId === id)),
  };
}

type DiscardSnapshot = ReturnType<typeof discardSnapshot>;

/** All controllers that could still journal this task, including an independent comparison driver. */
function controllers(value: DiscardSnapshot): Controller[] {
  const result: Controller[] = [];
  const state = value.task.guided;
  if (state?.owner) result.push(state.owner);
  if (state?.pending) result.push(state.pending.controller);
  for (const { workspace, lease } of value.workspaces) {
    if (workspace.owner) result.push({ ...workspace.owner, host: workspace.host });
    if (lease) result.push(lease);
  }
  for (const session of value.sessions) if (session.run) result.push(session.run);
  for (const group of value.comparisons) {
    if (group.owner) result.push(group.owner);
    if (group.integration && group.integration.phase !== 'integrated') result.push(group.integration.owner);
  }
  return result;
}

function requireDiscardable(store: Store, value: DiscardSnapshot, expected: string) {
  const { task } = value;
  const state = task.guided;
  if (task.deletedAt) throw new Error('Task was already deleted');
  if (!state || state.status !== 'recovery_required') throw new Error('Only a task awaiting recovery can be discarded');
  if (guidedDecisionKey(state, guidedQuestionKey(store, state)) !== expected)
    throw new StaleStateError('Task changed; refresh before discarding it');
  return state;
}

/**
 * Hides an explicitly abandoned recovery task once every recorded controller is provably dead on this
 * host. Process probes happen outside the write transaction; the entire ownership snapshot is checked
 * again inside it. No leaf operation is stopped, replayed, marked settled or granted a free workspace.
 * The dead guided runner is released, while its pending intent and all execution leases are retained.
 * Any containing comparison loses approval so its driver cannot start another member later.
 */
export function discardTask(store: Store, id: string, expected: string): { ok: true } {
  const before = discardSnapshot(store, id);
  requireDiscardable(store, before, expected);
  const observed = new Set<string>();
  for (const owner of controllers(before)) {
    const identity = JSON.stringify(owner);
    if (observed.has(identity)) continue;
    observed.add(identity);
    if (owner.host !== hostname() || processAlive(owner.controllerPid, owner.controllerStartedAt))
      throw new Error(
        'A recorded controller is still alive, on another host or unverifiable; stop it before discarding',
      );
  }
  return store.transaction(() => {
    const current = discardSnapshot(store, id);
    if (!deepEqual(current, before)) throw new StaleStateError('Task ownership changed; refresh before discarding it');
    const state = requireDiscardable(store, current, expected);
    const owner = state.owner;
    const deletedAt = new Date().toISOString();
    current.task.deletedAt = deletedAt;
    current.task.approvedVersion = null;
    state.owner = null;
    for (const group of current.comparisons)
      changeComparison(store, group.id, 'comparison.member_discarded', value => {
        value.owner = null;
        value.approvedDigest = null;
        value.pauseRequested = true;
        value.status = 'waiting';
        value.note = 'A member was discarded. This comparison cannot run again; its results and evidence are retained.';
      });
    store.save(id, current.task);
    store.append(id, current.task.version, 'task.discarded', {
      deletedAt,
      previousOwner: owner,
      retained: 'Uncertain outcomes, pending intent, workspace leases, files, commits and journal evidence',
      acceptedAsSuccess: false,
      replayed: false,
    });
    return { ok: true };
  });
}
