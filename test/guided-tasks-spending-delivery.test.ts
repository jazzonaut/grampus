// Exhaustion after the final required agent turn must still allow real acceptance and Git delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { spendingStatus } from '../src/orchestration/guided/spending.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import type { Usage } from '../src/providers/types.js';
import { fixture, inlineImplementation, services, review, windows } from './helpers/guided-tasks.js';

test(
  'the final allowed review can finish acceptance and verified Git delivery at both thresholds',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    const usage: Usage = {
      scope: 'provider-session-cumulative',
      complete: true,
      inputTokens: 40,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostUsd: null,
      billedCostUsd: null,
    };
    config.implementationRunner = options => inlineImplementation(options, "console.log('hello world');\n", usage);
    config.connector = async () => ({
      turn: async () => ({ status: 'completed', reply: review, usage, error: null }),
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic', maxTaskTurns: 2, maxTaskTokens: 100 },
      quality: { passes: [] },
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const done = await tasks.run(task.id);
    assert.equal(done.status, 'complete', done.note);
    const measured = spendingStatus(taskUsage(f.store, task.id), done.plan.workflowPolicy);
    assert.equal(measured.turns, 2);
    assert.equal(measured.tokens, 100);
    assert.equal(measured.remainingTurns, 0);
    assert.equal(measured.remainingTokens, 0);
    assert.equal(f.store.events(task.id, ['guided.spending_blocked']).length, 0);
    assert.equal(f.store.get(task.id).phase, 'complete');
  },
);
