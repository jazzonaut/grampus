// Review receives actual acceptance results for the candidate that is then delivered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, lens, review, services, windows } from './helpers/guided-tasks.js';

test('the independent reviewer sees completed acceptance evidence', windows, async t => {
  const f = fixture(t);
  const config = services();
  config.connector = async () => ({
    turn: async () => {
      const task = f.store.list()[0]!;
      assert.ok(task.evidence.some(item => item.kind === 'verification' && item.outcome === 'passed'));
      return {
        status: 'completed',
        reply: { ...review, lenses: [lens('pass', 'Inspected code and acceptance evidence.')] },
        usage: null,
        error: null,
      };
    },
    interrupt: async () => {},
    close: async () => {},
  });
  f.plan.workflowPolicy.mode = 'automatic';
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create(f.plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.status, 'complete', state.note);
});
