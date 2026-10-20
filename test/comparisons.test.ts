// Comparison integration tests use real SQLite and isolated Git worktrees; providers alone are fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { integrateComparison, integrationPreview } from '../src/orchestration/comparison-integration.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { exportRun } from '../src/reporting/run-export.js';
import { runMetrics } from '../src/reporting/run-metrics.js';
import { fixture, services, inlineImplementation, review, git, windows } from './helpers/guided-tasks.js';

const profiles = ['economy', 'thorough'].map(id => ({
  id,
  name: id,
  planning: { provider: 'codex', model: 'planner' },
  implementation: { provider: 'codex', model: id, effort: 'low' },
  review: { provider: 'claude', model: 'reviewer', effort: 'high' },
}));

test(
  'batch approval binds isolated runs, dispatches sequentially and exports failed and successful evidence',
  windows,
  async t => {
    const f = fixture(t);
    const source = f.tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic', repairRounds: 0 },
      quality: { passes: [] },
    });
    const config = services();
    const order: string[] = [];
    config.implementationRunner = options => {
      const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
      const session = f.store.session(execution.sessionId);
      order.push(session.model!);
      return inlineImplementation(
        options,
        session.model === 'economy' ? "console.log('wrong');\n" : "console.log('hello world');\n",
      );
    };
    config.connector = async () => ({
      turn: async () => ({ status: 'completed', reply: { ...review, lenses: [] }, usage: null, error: null }),
      interrupt: async () => {},
      close: async () => {},
    });
    const comparisons = new Comparisons(f.store, config);
    const group = comparisons.create(source.id, source.guided!.digest, profiles);
    assert.equal(group.status, 'draft');
    assert.notEqual(
      f.store.get(group.runs[0]!.taskId).guided!.plan.workspace.path,
      f.store.get(group.runs[1]!.taskId).guided!.plan.workspace.path,
    );
    assert.throws(() => comparisons.approve(group.id, 'stale'));
    comparisons.approve(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
    await assert.rejects(() => new GuidedTasks(f.store).run(group.runs[1]!.taskId), /comparison turn/);
    const result = await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
    assert.equal(result.status, 'complete', result.note);
    assert.deepEqual(order, ['economy', 'thorough']);
    for (const run of result.runs) {
      assert.equal(runMetrics(f.store, run.taskId).verifiedDelivery, run.profile.id === 'thorough');
      const exported = exportRun(f.store, run.taskId);
      assert.equal(exported.format, 'grampus.run');
      assert.ok(exported.sessions.length >= 1);
      assert.ok(
        exported.attachments.some(attachment =>
          attachment.files.some(file => file.name === 'stdout' && file.status === 'included'),
        ),
      );
      if (run.profile.id === 'thorough') assert.ok(exported.executions.some(item => item.deliveries.length));
      assert.ok(exported.sessions.some(item => item.events.some(event => event.type === 'turn.requested')));
    }
    const before = git(f.repo, 'rev-parse', 'HEAD');
    comparisons.select(group.id, comparisonDecisionKey(f.store.comparison(group.id)), group.runs[1]!.taskId);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, 'preference does not integrate changes');
    assert.equal(f.store.comparison(group.id).preferredTaskId, group.runs[1]!.taskId);
    assert.throws(() => comparisons.select(group.id, comparisonDecisionKey(f.store.comparison(group.id)), source.id));
    const key = comparisonDecisionKey(f.store.comparison(group.id));
    const target = integrationPreview(f.store, group.id, key);
    await integrateComparison(f.store, group.id, key, target);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target.commit);
    await assert.rejects(
      () => integrateComparison(f.store, group.id, comparisonDecisionKey(f.store.comparison(group.id)), target),
      /already requested/,
    );
  },
);

test('a changed member rolls back batch approval and shared work cannot be altered by a profile', t => {
  const f = fixture(t),
    source = f.tasks.create(f.plan),
    comparisons = new Comparisons(f.store);
  const group = comparisons.create(source.id, source.guided!.digest, profiles);
  const task = f.store.get(group.runs[1]!.taskId);
  task.guided!.plan.slices[0]!.message = 'Changed after inspection';
  f.store.save(task.id, task);
  assert.throws(() => comparisons.approve(group.id, comparisonDecisionKey(f.store.comparison(group.id))));
  assert.equal(f.store.get(group.runs[0]!.taskId).approvedVersion, null);
  assert.equal(f.store.comparison(group.id).approvedDigest, null);
});
