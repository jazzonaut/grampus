// Exercises explicit discard of missing-receipt runs through the controller and dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { discardTask } from '../src/orchestration/task-discard.js';
import { StaleStateError } from '../src/persistence/errors.js';
import { Checks } from '../src/verification/checks.js';
import { startUi } from '../src/server/ui-server.js';
import { connect } from './helpers/dashboard.js';
import { fixture, preparation } from './helpers/guided-tasks.js';

test('discard hides a dead comparison member without settling its missing-receipt operation', async t => {
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  let close = async () => {};
  t.after(async () => {
    await close();
    for (const cleanup of cleanups) cleanup();
  });
  const source = f.tasks.create({ ...f.plan, preparation: preparation("console.log('restore')") });
  const comparisons = new Comparisons(f.store);
  const profiles = ['first', 'second'].map(id => ({
    id,
    name: id,
    planning: { provider: 'codex', model: 'planner' },
    implementation: { provider: 'codex', model: id },
    review: { provider: 'claude', model: 'reviewer' },
  }));
  const group = comparisons.create(source.id, source.guided!.digest, profiles);
  comparisons.approve(group.id, comparisonDecisionKey(group));
  const storeModule = JSON.stringify(new URL('../src/persistence/store.js', import.meta.url).href);
  const comparisonModule = JSON.stringify(new URL('../src/orchestration/comparisons.js', import.meta.url).href);
  const result = {
    reason: 'supervisor_lost',
    exitCode: null,
    exitConfirmed: false,
    stdout: '',
    stderr: '',
    outputTruncated: false,
  };
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { Store } from ${storeModule};
    import { Comparisons } from ${comparisonModule};
    const store = new Store(${JSON.stringify(f.store.path)});
    try { await new Comparisons(store, { preparationRunner: async () => (${JSON.stringify(result)}) })
      .run(${JSON.stringify(group.id)}, ${JSON.stringify(comparisonDecisionKey(f.store.comparison(group.id)))}); }
    finally { store.close(); }
  `,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  const id = group.runs[0]!.taskId;
  const before = f.store.get(id);
  const state = before.guided!;
  assert.equal(state.status, 'recovery_required');
  assert.equal(state.stopReason?.code, 'OPERATION_NEEDS_RECOVERY');
  const check = f.store.checks(state.executionId!)[0]!;
  assert.throws(() => new Checks(f.store).recover(check.id), /ENOENT/);
  const lease = f.store.lease(state.workspaceId!);
  const original = f.store.get(source.id);
  const retained = join(f.store.workspace(state.workspaceId!).path!, 'retained.txt');
  writeFileSync(retained, 'Retain user work');
  const ui = await startUi({ db: f.store.path, port: 0 });
  close = () => ui.close();
  const api = connect(ui);
  const view = await api.task(id);
  const action = view.decisions.find(item => item.request.path.endsWith('/discard'));
  assert.ok(action, 'Recovery must offer an explicit discard action');
  assert.equal(action.enabled, true);
  assert.ok(action.confirm);
  assert.equal((await api.post(action.request.path, { expected: 'stale' })).status, 409);
  assert.equal((await api.post(`/api/tasks/${id}/delete`, action.request.body)).status, 400);
  const groupBefore = f.store.comparison(group.id);
  const activeController = { host: hostname(), controllerPid: process.pid, controllerStartedAt: null };
  f.store.transaction(() => {
    f.store.releaseLease(state.workspaceId!, lease!.executionId, lease!.runId);
    f.store.acquireLease(state.workspaceId!, lease!.executionId, lease!.runId, { ...lease!, ...activeController });
  });
  assert.equal((await api.act(action)).status, 400, 'A live leaf controller must prevent discard');
  assert.equal(f.store.get(id).deletedAt, undefined);
  f.store.transaction(() => {
    f.store.releaseLease(state.workspaceId!, lease!.executionId, lease!.runId);
    f.store.acquireLease(state.workspaceId!, lease!.executionId, lease!.runId, lease!);
    f.store.saveComparison({ ...groupBefore, owner: { ...activeController, token: 'live-driver' } });
  });
  assert.equal((await api.act(action)).status, 400, 'A live comparison driver must prevent discard');
  f.store.transaction(() => f.store.saveComparison(groupBefore));
  const append = ui.store.append.bind(ui.store);
  const failing = t.mock.method(ui.store, 'append', (...args: Parameters<typeof append>) => {
    if (args[2] === 'task.discarded') throw new Error('Journal unavailable');
    return append(...args);
  });
  assert.equal((await api.act(action)).status, 400);
  failing.mock.restore();
  assert.deepEqual(f.store.get(id), before);
  assert.deepEqual(f.store.comparison(group.id), groupBefore);
  const transaction = ui.store.transaction.bind(ui.store);
  const racing = t.mock.method(ui.store, 'transaction', (work: () => unknown) => {
    transaction(() => {
      const task = ui.store.get(id);
      task.guided!.owner = { ...activeController, token: 'replacement-controller' };
      ui.store.save(id, task);
    });
    return transaction(work);
  });
  assert.throws(() => discardTask(ui.store, id, action.expected!), StaleStateError);
  racing.mock.restore();
  assert.equal(f.store.get(id).deletedAt, undefined);
  assert.deepEqual(f.store.comparison(group.id), groupBefore);
  f.store.transaction(() => f.store.save(id, before));
  const response = await api.act(action);
  assert.equal(response.status, 200, await response.text());
  const discarded = f.store.get(id);
  assert.ok(discarded.deletedAt);
  assert.equal(discarded.approvedVersion, null);
  assert.equal(discarded.phase, before.phase);
  assert.deepEqual(discarded.attempt, before.attempt);
  assert.deepEqual(discarded.guided, { ...state, owner: null });
  assert.deepEqual(f.store.lease(state.workspaceId!), lease);
  assert.deepEqual(f.store.check(check.id), check);
  assert.equal(existsSync(retained), true);
  assert.deepEqual(f.store.get(source.id), original);
  assert.equal(f.store.runnerOwners().includes(id), false);
  assert.equal((await api.raw(`/api/v1/tasks/${id}`)).status, 404);
  assert.equal(
    (await api.overview()).tasks.some(task => task.id === id),
    false,
  );
  assert.ok(f.store.events(id).some(event => event.type === 'task.discarded'));
  assert.equal(f.store.comparison(group.id).approvedDigest, null);
  await assert.rejects(comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id))), /unapproved/);
  await assert.rejects(f.tasks.run(id));
  assert.deepEqual(f.store.check(check.id), check);
});
