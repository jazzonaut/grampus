// Pins group approval after an individual member was approved and the task-screen guidance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { Workspaces } from '../src/repository/workspaces.js';
import { taskActions } from '../src/server/view-model/actions.js';
import { taskActionFacts, taskFacts } from '../src/server/view-model/task-detail.js';
import { fixture } from './helpers/guided-tasks.js';

const profiles = ['first', 'second'].map(id => ({
  id,
  name: id,
  planning: { provider: 'codex', model: 'planner' },
  implementation: { provider: 'codex', model: id },
  review: { provider: 'claude', model: 'reviewer' },
}));

test('batch approval accepts an exactly approved member that has never started', t => {
  const f = fixture(t);
  const source = f.tasks.create(f.plan);
  const comparisons = new Comparisons(f.store);
  const group = comparisons.create(source.id, source.guided!.digest, profiles);
  const first = f.store.get(group.runs[0]!.taskId);
  f.tasks.approve(first.id, first.version, first.guided!.digest);
  const approvedFirst = f.store.get(first.id);
  const events = f.store.events(first.id);
  const approved = comparisons.approve(group.id, comparisonDecisionKey(group));
  assert.equal(approved.approvedDigest, approved.digest);
  assert.equal(approved.status, 'ready');
  assert.deepEqual(f.store.get(first.id), approvedFirst);
  assert.deepEqual(f.store.events(first.id), events, 'The individual approval must not be repeated');
  assert.equal(f.store.get(group.runs[1]!.taskId).guided!.status, 'ready');
  assert.equal(f.store.get(source.id).guided!.status, 'draft');
  assert.equal(f.store.workspaces().length, 0, 'Batch approval must not dispatch any work');
});

test('member task screens direct initial approval and continuation to Comparisons', t => {
  const f = fixture(t);
  const source = f.tasks.create(f.plan);
  const group = new Comparisons(f.store).create(source.id, source.guided!.digest, profiles);
  const context = { job: () => null, stall: () => null, pool: { active: 0, limit: 2, owners: [] }, qualityPasses: [] };
  const member = group.runs[0]!;
  let actions = taskActions(taskActionFacts(taskFacts(f.store, member.taskId), context));
  assert.equal(actions.find(item => item.id === 'approve')?.enabled, false);
  assert.match(actions.find(item => item.id === 'approve')?.disabledReason ?? '', /Approve all profiles/);
  f.tasks.approve(member.taskId, member.version, member.digest);
  actions = taskActions(taskActionFacts(taskFacts(f.store, member.taskId), context));
  assert.equal(actions.find(item => item.id === 'run')?.enabled, false);
  assert.match(actions.find(item => item.id === 'run')?.disabledReason ?? '', /Run comparison/);
  assert.equal(taskActions(taskActionFacts(taskFacts(f.store, source.id), context))[0]!.enabled, true);
});

test('prior individual approval never waives exact approval bindings or an unstarted workspace', async t => {
  const f = fixture(t);
  const source = f.tasks.create(f.plan);
  const comparisons = new Comparisons(f.store);
  const group = comparisons.create(source.id, source.guided!.digest, profiles);
  const run = group.runs[0]!;
  f.tasks.approve(run.taskId, run.version, run.digest);
  const original = f.store.get(run.taskId);
  const variants = Array.from({ length: 4 }, () => structuredClone(original));
  variants[0]!.approvedVersion = null;
  variants[1]!.guided!.approvedDigest = 'different-approval';
  variants[2]!.guided!.workspaceId = 'retained-workspace';
  variants[3]!.brief.outcome = 'Work outside the approved plan';
  for (const task of variants) {
    f.store.transaction(() => f.store.save(task.id, task));
    assert.throws(() => comparisons.approve(group.id, comparisonDecisionKey(group)));
    assert.deepEqual(f.store.comparison(group.id), group);
    assert.equal(f.store.get(group.runs[1]!.taskId).guided!.status, 'draft');
  }
  f.store.transaction(() => f.store.save(original.id, original));
  const workspace = await new Workspaces(f.store).create(
    run.taskId,
    run.version,
    f.repo,
    join(f.root, 'retained-workspace'),
  );
  assert.throws(() => comparisons.approve(group.id, comparisonDecisionKey(group)));
  assert.deepEqual(f.store.comparison(group.id), group);
  assert.deepEqual(f.store.workspace(workspace.id), workspace);
});
