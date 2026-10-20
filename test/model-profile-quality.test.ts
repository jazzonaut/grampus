// Verifies an edit pass's fixed assignment while retaining ordinary checks and independent review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { taskTurnUsage } from '../src/reporting/task-usage.js';
import { fixture, services, inlineImplementation, review, windows } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

test(
  'a quality edit uses its own model and effort, then validates and reviews the resulting artifact',
  windows,
  async t => {
    const f = fixture(t),
      config = services(),
      seen: string[] = [];
    config.implementationRunner = options => {
      const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
      const session = f.store.session(execution.sessionId);
      seen.push(`${session.model}:${session.effort}`);
      return inlineImplementation(options, "console.log('hello world');\n");
    };
    config.connector = async () => ({
      turn: async () => ({ status: 'completed', reply: { ...review, lenses: [] }, usage: null, error: null }),
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: ['documentation'] },
      modelProfile: profile,
    });
    tasks.approve(task.id, task.version, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(result.status, 'complete', result.note);
    assert.deepEqual(seen, ['writer:low', 'documenter:low']);
    assert.equal(result.qualityEdits.length, 1);
    assert.deepEqual(
      taskTurnUsage(f.store, task.id)
        .filter(turn => turn.provider === 'codex')
        .map(turn => turn.requestedModel),
      ['writer', 'documenter'],
    );
  },
);
