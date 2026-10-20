// Pins durable comparison retry decisions without provider calls; Git and SQLite remain real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { comparisonRetries } from '../src/domain/comparison-retries.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { taskActions } from '../src/server/view-model/actions.js';
import { taskActionFacts, taskFacts } from '../src/server/view-model/task-detail.js';
import { fixture } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';
import { Store } from '../src/persistence/store.js';

function queuedFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const comparisons = new Comparisons(f.store);
  const source = f.tasks.create(f.plan);
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'second' }]);
  comparisons.approve(group.id, comparisonDecisionKey(group));
  const first = f.store.get(group.runs[0]!.taskId);
  first.guided!.status = 'blocked';
  first.guided!.stopReason = {
    code: 'READINESS_REPAIR_EXHAUSTED',
    message: 'Readiness allowance exhausted',
    at: new Date().toISOString(),
  };
  first.guided!.readinessCycle.used = first.guided!.plan.workflowPolicy.readinessRounds;
  f.store.transaction(() => {
    f.store.save(first.id, first);
    const current = f.store.comparison(group.id);
    current.cursor = 1;
    current.status = 'running';
    current.owner = { token: randomUUID(), host: 'test-host', controllerPid: process.pid, controllerStartedAt: null };
    f.store.saveComparison(current);
    f.store.appendComparison(group.id, 'comparison.started', current);
  });
  return { ...f, comparisons, group, first };
}

test('retry queues behind the active member, survives reopening SQLite and disables duplicate clicks even with a full pool', async t => {
  const f = queuedFixture(t);
  const before = f.store.get(f.first.id);
  const context = {
    job: () => null,
    stall: () => null,
    pool: { active: 2, limit: 2, owners: ['one', 'two'] },
    qualityPasses: [],
  };
  const actions = () => taskActions(taskActionFacts(taskFacts(f.store, f.first.id), context));
  assert.equal(actions().find(action => action.id === 'retry')?.label, 'Queue repair retry');
  assert.equal(actions().find(action => action.id === 'retry')?.enabled, true);
  const result = await new GuidedTasks(f.store, { expectedState: guidedDecisionKey(before.guided!) }).retry(f.first.id);
  assert.equal(result.stopReason?.code, 'READINESS_REPAIR_EXHAUSTED');
  assert.deepEqual(f.store.get(f.first.id), before, 'Queueing must not change the attempt or spend an allowance');
  const retries = comparisonRetries(f.store, f.group.id);
  assert.equal(retries.pending.length, 1);
  assert.equal(retries.active, null);
  const reopened = new Store(f.store.path);
  try {
    assert.deepEqual(comparisonRetries(reopened, f.group.id), retries);
  } finally {
    reopened.close();
  }
  assert.equal(f.store.comparison(f.group.id).cursor, 1);
  assert.equal(actions().find(action => action.id === 'retry')?.label, 'Repair retry queued');
  assert.equal(actions().find(action => action.id === 'retry')?.enabled, false);
  await assert.rejects(() => f.tasks.retry(f.first.id), /already queued/);
  assert.deepEqual(comparisonRetries(f.store, f.group.id), retries);
});

test('stale decisions, uncertain work and unapproved members cannot queue a comparison retry', async t => {
  const f = queuedFixture(t);
  const beforeEvents = f.store.comparisonEvents(f.group.id);
  await assert.rejects(() => new GuidedTasks(f.store, { expectedState: 'stale' }).retry(f.first.id), /changed/);
  const original = f.store.get(f.first.id);
  for (const change of [
    { owner: { token: randomUUID(), host: 'test-host', controllerPid: process.pid, controllerStartedAt: null } },
    { status: 'recovery_required' },
    { approvedDigest: null },
  ] as const) {
    const task = structuredClone(original);
    Object.assign(task.guided!, change);
    f.store.save(task.id, task);
    await assert.rejects(() => f.tasks.retry(task.id));
  }
  f.store.save(original.id, original);
  const group = f.store.comparison(f.group.id);
  group.approvedDigest = null;
  f.store.saveComparison(group);
  await assert.rejects(() => f.tasks.retry(original.id), /approved comparison/);
  assert.deepEqual(f.store.comparisonEvents(f.group.id), beforeEvents);
});

test('a started retry is never pending again after its driver exits', async t => {
  const f = queuedFixture(t);
  await f.tasks.retry(f.first.id);
  const retry = comparisonRetries(f.store, f.group.id).pending[0]!;
  f.store.transaction(() => f.store.appendComparison(f.group.id, 'comparison.retry_started', { retry }));
  assert.equal(comparisonRetries(f.store, f.group.id).pending.length, 0);
  assert.deepEqual(comparisonRetries(f.store, f.group.id).active, retry);
  f.store.transaction(() => f.store.appendComparison(f.group.id, 'comparison.retry_finished', { retry }));
  assert.deepEqual(comparisonRetries(f.store, f.group.id), { pending: [], active: null });
  const next = { ...retry, id: randomUUID() };
  f.store.transaction(() => {
    f.store.appendComparison(f.group.id, 'comparison.retry_requested', { retry: next });
    f.store.appendComparison(f.group.id, 'comparison.retry_started', {
      retry: { ...next, taskId: f.group.runs[1]!.taskId },
    });
  });
  assert.throws(() => comparisonRetries(f.store, f.group.id), /inconsistent dispatch/);
});

test('a queued retry waits for the current human checkpoint without dispatching work', async t => {
  const f = queuedFixture(t);
  await f.tasks.retry(f.first.id);
  f.store.transaction(() => {
    const current = f.store.comparison(f.group.id);
    current.owner = null;
    current.status = 'waiting';
    f.store.saveComparison(current);
    const active = f.store.get(current.runs[1]!.taskId);
    active.guided!.status = 'awaiting_scope';
    f.store.save(active.id, active);
  });
  await f.comparisons.run(f.group.id, comparisonDecisionKey(f.store.comparison(f.group.id)));
  assert.equal(f.store.executions().length, 0);
  assert.equal(comparisonRetries(f.store, f.group.id).pending.length, 1);
  assert.equal(comparisonRetries(f.store, f.group.id).active, null);
  assert.equal(f.store.comparison(f.group.id).status, 'waiting');
});

test('a stale queued decision is refused before dispatch and never silently refreshed', async t => {
  const f = queuedFixture(t);
  await f.tasks.retry(f.first.id);
  f.store.transaction(() => {
    const group = f.store.comparison(f.group.id);
    group.owner = null;
    group.cursor = group.runs.length;
    group.status = 'ready';
    f.store.saveComparison(group);
    const task = f.store.get(f.first.id);
    task.guided!.failedCheckId = randomUUID();
    f.store.save(task.id, task);
  });
  const result = await f.comparisons.run(f.group.id, comparisonDecisionKey(f.store.comparison(f.group.id)));
  assert.equal(result.status, 'waiting');
  assert.match(result.note, /changed since you inspected/);
  assert.equal(f.store.executions().length, 0);
  assert.deepEqual(comparisonRetries(f.store, f.group.id), { active: null, pending: [] });
});

test('continuing a recovered driver never dispatches an already started retry again', async t => {
  const f = queuedFixture(t);
  await f.tasks.retry(f.first.id);
  const retry = comparisonRetries(f.store, f.group.id).pending[0]!;
  f.store.transaction(() => {
    const group = f.store.comparison(f.group.id);
    group.cursor = group.runs.length;
    group.owner = null;
    group.status = 'waiting';
    f.store.saveComparison(group);
    f.store.appendComparison(group.id, 'comparison.retry_started', { retry });
    f.store.appendComparison(group.id, 'comparison.recovered', group);
  });
  let calls = 0;
  const comparisons = new Comparisons(f.store, {
    implementationRunner: () => {
      calls++;
      throw new Error('A started request must never be dispatched again');
    },
  });
  const result = await comparisons.run(f.group.id, comparisonDecisionKey(f.store.comparison(f.group.id)));
  assert.equal(result.status, 'complete');
  assert.equal(calls, 0);
  assert.equal(f.store.get(f.first.id).guided!.stopReason?.code, 'READINESS_REPAIR_EXHAUSTED');
  assert.deepEqual(comparisonRetries(f.store, f.group.id), { active: null, pending: [] });
});

test('a paused comparison retains its queued retry without dispatch, and requested integration refuses another', async t => {
  const f = queuedFixture(t);
  f.store.transaction(() => {
    const group = f.store.comparison(f.group.id);
    group.owner = null;
    group.pauseRequested = true;
    f.store.saveComparison(group);
  });
  await f.tasks.retry(f.first.id);
  assert.equal(f.store.comparison(f.group.id).pauseRequested, true);
  assert.equal(comparisonRetries(f.store, f.group.id).pending.length, 1);
  assert.equal(f.store.executions().length, 0);
  const group = f.store.comparison(f.group.id);
  group.integration = {
    taskId: f.first.id,
    repository: f.repo,
    branch: 'main',
    base: 'base',
    commit: 'commit',
    phase: 'requested',
    owner: { token: randomUUID(), host: 'test-host', controllerPid: process.pid, controllerStartedAt: null },
    error: null,
  };
  f.store.saveComparison(group);
  await assert.rejects(() => f.tasks.retry(f.first.id), /without requested integration/);
  assert.equal(comparisonRetries(f.store, f.group.id).pending.length, 1);
});

test('comparison membership is rechecked atomically when claiming a task runner', async t => {
  const f = queuedFixture(t);
  const id = f.group.runs[1]!.taskId;
  const transaction = f.store.transaction.bind(f.store);
  let advanced = false;
  f.store.transaction = action => {
    if (!advanced) {
      advanced = true;
      transaction(() => {
        const group = f.store.comparison(f.group.id);
        group.cursor = group.runs.length;
        group.status = 'complete';
        group.owner = null;
        f.store.saveComparison(group);
        f.store.appendComparison(group.id, 'comparison.completed', group);
      });
    }
    return transaction(action);
  };
  try {
    await assert.rejects(() => f.tasks.run(id), /comparison turn/);
    assert.equal(f.store.get(id).guided!.owner, null);
    assert.equal(f.store.workspaces().length, 0);
  } finally {
    f.store.transaction = transaction;
  }
});

test('advancing the comparison rechecks a concurrent task claim before starting another profile', async t => {
  const f = queuedFixture(t);
  const transaction = f.store.transaction.bind(f.store);
  transaction(() => {
    const group = f.store.comparison(f.group.id);
    group.cursor = 0;
    group.status = 'ready';
    group.owner = null;
    f.store.saveComparison(group);
  });
  let transactions = 0;
  f.store.transaction = action => {
    if (++transactions === 2) {
      transaction(() => {
        const task = f.store.get(f.first.id);
        task.guided!.owner = {
          token: randomUUID(),
          host: 'test-host',
          controllerPid: process.pid,
          controllerStartedAt: null,
        };
        f.store.save(task.id, task);
        f.store.append(task.id, task.version, 'guided.controller_claimed', { owner: task.guided!.owner });
      });
    }
    return transaction(action);
  };
  try {
    const result = await f.comparisons.run(f.group.id, comparisonDecisionKey(f.store.comparison(f.group.id)));
    assert.equal(result.cursor, 0);
    assert.equal(result.status, 'waiting');
    assert.equal(f.store.workspaces().length, 0);
    assert.ok(f.store.get(f.first.id).guided!.owner);
  } finally {
    f.store.transaction = transaction;
  }
});
