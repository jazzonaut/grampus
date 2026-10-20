// Owns explicit receipt-based recovery of a readiness group. All child exits must be proved before
// the group releases its shared lease; no command is replayed and recovered results stay interrupted.
import type { Store } from '../persistence/store.js';
import type { RepositoryCheck } from '../persistence/records.js';
import { readReceipt, requireDeadController } from './check-recovery.js';
import { retainedOutput } from '../process/check-process.js';

/** Group recovery reads every outstanding receipt before releasing any member's ownership. */
export function recoverCheckGroup(store: Store, id: string): RepositoryCheck {
  return store.transaction(() => {
    const first = store.check(id),
      execution = store.execution(first.executionId);
    const groupId = first.groupId;
    if (!groupId) throw new Error('Check has no group');
    const lease = store.lease(execution.workspaceId);
    if (!lease || lease.runId !== groupId || lease.executionId !== execution.id || lease.kind !== 'check')
      throw new Error('Readiness group no longer owns its workspace');
    requireDeadController(lease);
    const members = store.checks(execution.id).filter(check => check.groupId === groupId);
    for (const check of members) {
      if (!['running', 'recovery_required'].includes(check.phase)) continue;
      if (check.dispatch === 'requested') {
        if (!check.receipt) throw new Error('Group child has no settlement receipt; ownership retained');
        check.result = {
          ...readReceipt(check.receipt, check.supervisorPid, check.toolPid),
          ...retainedOutput(check.receipt.directory),
        };
      }
      check.phase = 'interrupted';
      check.error = 'Recovered group without replay or success acceptance; run an explicit fresh check';
      store.saveCheck(check.id, execution.id, check);
      const event = { checkId: check.id, groupId, replayed: false, acceptedAsSuccess: false };
      store.appendExecution(execution.id, 'check.recovered', event);
      store.append(execution.taskId, execution.version, 'check.recovered', event);
    }
    store.releaseLease(execution.workspaceId, execution.id, groupId);
    store.appendExecution(execution.id, 'lease.released', { runId: groupId });
    const task = store.get(execution.taskId);
    if (task.attempt?.id !== execution.attemptId || task.version !== execution.version)
      throw new Error('Recovery task binding changed');
    if (task.phase === 'recovery_required') {
      task.phase = 'running';
      task.attempt.outcome = 'running';
    }
    if (task.phase === 'stop_requested') {
      task.phase = 'stopped';
      task.attempt.outcome = 'stopped';
    }
    store.save(task.id, task);
    return store.check(id);
  });
}
