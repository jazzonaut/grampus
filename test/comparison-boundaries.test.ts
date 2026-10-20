// Exercises group boundaries with real task state and Git, replacing only provider process results.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { fixture, services, inlineImplementation, review, windows } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

test('uncertain member settlement never dispatches the next profile or repeats the provider', windows, async t => {
  const f = fixture(t),
    config = services();
  let calls = 0;
  config.implementationRunner = async () => {
    calls++;
    return {
      reason: 'interrupted',
      exitCode: null,
      exitConfirmed: false,
      stdout: '',
      stderr: '',
      outputTruncated: false,
    };
  };
  const comparisons = new Comparisons(f.store, config);
  const source = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'second' }]);
  comparisons.approve(group.id, comparisonDecisionKey(group));
  await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
  const stopped = f.store.comparison(group.id);
  assert.equal(stopped.status, 'waiting');
  assert.equal(stopped.cursor, 0);
  assert.equal(calls, 1);
  assert.equal(f.tasks.get(group.runs[0]!.taskId).status, 'recovery_required');
  await comparisons.run(group.id, comparisonDecisionKey(stopped));
  assert.equal(calls, 1);
  assert.equal(f.store.get(group.runs[1]!.taskId).guided!.status, 'ready');
});

test('a group pause settles its operation and explicit continuation resumes the same member', windows, async t => {
  const f = fixture(t),
    config = services();
  let implementations = 0,
    reviews = 0;
  config.implementationRunner = options => {
    implementations++;
    comparisons.pause(groupId, comparisonDecisionKey(f.store.comparison(groupId)));
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  config.connector = async () => ({
    turn: async () => {
      reviews++;
      comparisons.pause(groupId, comparisonDecisionKey(f.store.comparison(groupId)));
      return { status: 'completed', reply: { ...review, lenses: [] }, usage: null, error: null };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const comparisons = new Comparisons(f.store, config);
  const source = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'second' }]);
  const groupId = group.id;
  comparisons.approve(group.id, comparisonDecisionKey(group));
  await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
  assert.equal(f.tasks.get(group.runs[0]!.taskId).stopReason?.code, 'USER_PAUSED');
  assert.equal(f.store.comparison(group.id).cursor, 0);
  await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
  assert.equal(implementations, 1);
  assert.equal(reviews, 1);
  assert.equal(f.tasks.get(group.runs[0]!.taskId).stopReason?.code, 'USER_PAUSED');
  assert.equal(f.store.comparison(group.id).cursor, 0);
});
