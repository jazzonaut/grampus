// A pause during review can retain a scheduled repair but must not dispatch its implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, review, inlineImplementation, windows } from './helpers/guided-tasks.js';

test('pause during a blocking review keeps the allocated repair without starting another turn', windows, async t => {
  const f = fixture(t);
  const config = services();
  let implementations = 0,
    reviews = 0;
  config.implementationRunner = options => {
    implementations++;
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  config.connector = async () => ({
    turn: async () => {
      reviews++;
      tasks.pause(id);
      return {
        status: 'completed',
        reply: {
          ...review,
          findings: [
            {
              severity: 'blocking',
              description: 'Fixture defect to repair',
              evidence: 'greeting.js:1',
            },
          ],
        },
        usage: null,
        error: null,
      };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
  const id = task.id;
  tasks.approve(id, 1, task.guided!.digest);
  const paused = await tasks.run(id);
  assert.equal(paused.stopReason?.code, 'USER_PAUSED', paused.note);
  assert.equal(paused.stage, 'execution');
  assert.equal(implementations, 1);
  assert.equal(reviews, 1);
  assert.equal(paused.repairCycle.used, 1, 'the review scheduled one repair before the pause boundary');
  const decisions = f.store.events(id, ['guided.repair_decided']);
  assert.equal(decisions.length, 1);
  const data = decisions[0]!.data as { progress: string; trigger: string };
  assert.equal(data.progress, 'initial', 'a first review cannot claim earlier findings were resolved');
  assert.match(data.trigger, /Fixture defect to repair/);
  assert.equal(paused.pending, null);
  assert.equal(paused.owner, null);
});
