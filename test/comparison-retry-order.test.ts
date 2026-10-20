// Runs queued retries through the actual comparison driver; only provider receipts are synthetic.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { comparisonRetries } from '../src/domain/comparison-retries.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, windows } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

test(
  'an explicit retry waits for the active profile, then runs once without replaying completed work',
  windows,
  async t => {
    const f = fixture(t);
    const config = services();
    const comparisons = new Comparisons(f.store, config);
    const source = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
    const group = comparisons.create(source.id, source.guided!.digest, [
      profile,
      { ...profile, id: 'second', implementation: { ...profile.implementation, model: 'second' } },
    ]);
    const order: string[] = [];
    config.implementationRunner = async options => {
      const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
      const model = f.store.session(execution.sessionId).model!;
      order.push(model);
      if (model === 'second') {
        const state = await new GuidedTasks(f.store, config).retry(group.runs[0]!.taskId);
        assert.equal(state.stopReason?.code, 'IMPLEMENTATION_FAILED');
        assert.equal(comparisonRetries(f.store, group.id).pending.length, 1);
        assert.equal(f.store.comparison(group.id).cursor, 1);
        assert.deepEqual(order, ['writer', 'second'], 'Queueing must not overlap providers');
      }
      writeFileSync(
        join(options.receipt!.directory, 'result.json'),
        JSON.stringify({
          id: options.receipt!.checkId,
          result: { status: 'failed', reply: null, usage: null, error: 'Settled fixture failure' },
        }),
      );
      return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
    };
    comparisons.approve(group.id, comparisonDecisionKey(group));
    const result = await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
    assert.deepEqual(order, ['writer', 'second', 'repairer']);
    assert.equal(result.status, 'complete');
    assert.equal(result.cursor, group.runs.length);
    assert.equal(result.digest, group.digest);
    assert.deepEqual(comparisonRetries(f.store, group.id), { active: null, pending: [] });
    assert.equal(
      f.store.comparisonEvents(group.id).filter(event => event.type === 'comparison.retry_started').length,
      1,
    );
  },
);
