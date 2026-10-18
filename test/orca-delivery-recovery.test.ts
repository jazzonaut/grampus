// Orca tests: lost-reply recovery and no-change delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { type CheckProcessResult } from '../src/check-process.js';
import type { ExecutionLease } from '../src/execution-state.js';
import { git, windows, deliveryFixture, supervisedOrcaWriter } from './helpers/orca.js';

test('Orca lost-reply delivery recovery needs a receipt and the original workspace identity', windows, async t => {
  for (const mode of ['commit', 'no_change'] as const)
    for (const replaced of [false, true]) {
      const f = await deliveryFixture(t, mode === 'no_change');
      let writerResult: CheckProcessResult | undefined;
      const delivery = await f.deliveries.run(f.execution.id, { ...f.spec, mode }, undefined, async options => {
        writerResult = await supervisedOrcaWriter(f, options);
        throw new Error('Fixture lost controller reply');
      });
      assert.equal(writerResult?.reason, 'exited', JSON.stringify(writerResult));
      assert.equal(writerResult?.exitCode, 0, JSON.stringify(writerResult));
      assert.equal(delivery.phase, 'recovery_required');
      const head = git(f.workspace.path, 'rev-parse', 'HEAD');
      const pid = Number(
        execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }),
      );
      const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
      f.store.transaction(() => {
        f.store.releaseLease(f.workspace.id, f.execution.id, lease.runId);
        f.store.acquireLease(f.workspace.id, f.execution.id, lease.runId, { ...lease, controllerPid: pid });
      });
      if (replaced) f.state.worktree!.isArchived = true;
      const recovered = await f.deliveries.recover(delivery.id);
      assert.equal(recovered.phase, replaced ? 'failed' : 'delivered');
      assert.equal(recovered.outcome, replaced ? null : mode === 'commit' ? 'committed' : 'no_change');
      if (mode === 'no_change') {
        assert.equal(recovered.commit, null);
        assert.equal(head, f.snapshot.head);
      }
      assert.equal(f.workflow.get(f.task.id).phase, replaced ? 'awaiting_verification' : 'complete');
      assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), head);
      assert.equal(f.store.lease(f.workspace.id), null);
    }
});

test('Orca no-change delivery verifies the original instance in the worker and at acceptance', windows, async t => {
  for (const archive of ['never', 'worker', 'acceptance']) {
    const f = await deliveryFixture(t, true);
    const delivery = await f.deliveries.run(
      f.execution.id,
      { ...f.spec, mode: 'no_change' },
      undefined,
      async options => {
        if (archive === 'worker') f.state.worktree!.isArchived = true;
        const result = await supervisedOrcaWriter(f, options);
        if (archive === 'acceptance') f.state.worktree!.isArchived = true;
        return result;
      },
    );
    assert.equal(delivery.phase, archive === 'never' ? 'delivered' : 'failed', JSON.stringify(delivery));
    assert.equal(delivery.outcome, archive === 'never' ? 'no_change' : null);
    assert.equal(delivery.commit, null);
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(git(f.workspace.path, 'status', '--porcelain'), '');
    assert.equal(f.workflow.get(f.task.id).phase, archive === 'never' ? 'complete' : 'awaiting_verification');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});
