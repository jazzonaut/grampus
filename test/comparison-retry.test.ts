// Exercises explicit retry after a comparison has advanced, with real Git and SQLite evidence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

test(
  'an earlier failed comparison member retries after the batch completes without losing its work',
  windows,
  async t => {
    const f = fixture(t);
    const config = services();
    const order: string[] = [];
    config.implementationRunner = options => {
      const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
      const model = f.store.session(execution.sessionId).model!;
      order.push(model);
      if (order.length === 3) assert.match(readFileSync(join(options.cwd, 'greeting.js'), 'utf8'), /wrong/);
      if (model === 'second' || order.length === 3) {
        writeFileSync(
          join(options.receipt!.directory, 'result.json'),
          JSON.stringify({
            id: options.receipt!.checkId,
            result: { status: 'failed', reply: null, usage: null, error: 'Settled fixture failure' },
          }),
        );
        return Promise.resolve({
          reason: 'exited',
          exitCode: 0,
          exitConfirmed: true,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        });
      }
      return inlineImplementation(options, "console.log('wrong');\n");
    };
    const source = f.tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic', repairRounds: 0 },
      quality: { passes: [] },
    });
    const comparisons = new Comparisons(f.store, config);
    const group = comparisons.create(source.id, source.guided!.digest, [
      profile,
      { ...profile, id: 'second', implementation: { ...profile.implementation, model: 'second' } },
    ]);
    comparisons.approve(group.id, comparisonDecisionKey(group));
    await comparisons.run(group.id, comparisonDecisionKey(f.store.comparison(group.id)));
    const id = group.runs[0]!.taskId;
    const before = f.store.get(id).guided!;
    assert.equal(before.stopReason?.code, 'CHECK_REPAIR_EXHAUSTED');
    assert.equal(f.store.comparison(group.id).status, 'complete');
    const retried = await new GuidedTasks(f.store, config).retry(id);
    assert.equal(retried.status, 'blocked');
    assert.equal(
      retried.stopReason?.code,
      'IMPLEMENTATION_FAILED',
      'The retry reaches the provider, rather than the comparison guard',
    );
    assert.equal(retried.workspaceId, before.workspaceId);
    assert.equal(retried.digest, before.digest);
    assert.deepEqual(retried.repairCycle, before.repairCycle);
    assert.deepEqual(order, [profile.implementation.model, 'second', profile.repair.model]);
    assert.equal(f.store.comparison(group.id).status, 'complete');
  },
);
