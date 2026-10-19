// Token thresholds refuse another provider turn after known exhaustion or missing measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import type { Usage } from '../src/providers/types.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

const measured: Usage = {
  scope: 'provider-session-cumulative',
  complete: true,
  inputTokens: 40,
  outputTokens: 10,
  cachedInputTokens: 20,
  cacheWriteInputTokens: null,
  estimatedCostUsd: null,
  billedCostUsd: null,
};

for (const usage of [measured, null])
  test(`token policy stops review when usage is ${usage ? 'at its threshold' : 'unknown'}`, windows, async t => {
    const f = fixture(t),
      config = services();
    let turns = 0;
    config.implementationRunner = options => {
      turns++;
      return inlineImplementation(options, "console.log('hello world');\n", usage);
    };
    config.connector = async () => {
      throw new Error('Token gate must stop review');
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic', maxTaskTokens: 50 },
      quality: { passes: [] },
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const stopped = await tasks.run(task.id);
    assert.equal(stopped.stopReason?.code, usage ? 'TASK_TOKEN_LIMIT' : 'TASK_USAGE_UNKNOWN', stopped.note);
    assert.equal(stopped.stage, 'review');
    assert.equal(stopped.pending, null);
    assert.equal(taskUsage(f.store, task.id).turns, 1);
    assert.equal(turns, 1);
    const event = f.store.events(task.id, ['guided.spending_blocked']).at(-1)!;
    const recorded = event.data as { spending: { tokens: number | null; turns: number; maxTokens: number } };
    assert.equal(recorded.spending.tokens, usage ? 50 : null);
    assert.equal(recorded.spending.maxTokens, 50);
    assert.equal(recorded.spending.turns, 1);
  });
