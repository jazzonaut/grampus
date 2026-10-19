// Human guidance binds before dispatch; later input survives a pause and reaches only a later turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { Store } from '../src/persistence/store.js';
import { fixture, inlineImplementation, services, review, windows } from './helpers/guided-tasks.js';

test(
  'late guidance cannot alter a running implementation and reaches the next review after reopening',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let implementations = 0,
      reviews = 0;
    config.implementationRunner = options => {
      implementations++;
      const request = JSON.parse(readFileSync(options.args.at(-1)!, 'utf8')) as { prompt: string };
      assert.match(request.prompt, /Keep the first implementation direct/);
      assert.throws(() => tasks.cancelGuidance(id, tasks.get(id).pending!.guidance[0]!.id), /no longer queued/);
      tasks.queueGuidance(id, 'Inspect the error path in the next review.', 'next_agent');
      assert.doesNotMatch(request.prompt, /Inspect the error path/);
      assert.equal(tasks.get(id).pending!.guidance.length, 1);
      tasks.pause(id);
      return inlineImplementation(options, "console.log('hello world');\n");
    };
    config.connector = async () => ({
      turn: async prompt => {
        reviews++;
        assert.match(prompt, /Inspect the error path in the next review/);
        assert.doesNotMatch(prompt, /Keep the first implementation direct/);
        assert.match(prompt, /cannot waive review, checks or acceptance/);
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
    const id = task.id;
    tasks.approve(id, 1, task.guided!.digest);
    tasks.queueGuidance(id, 'Keep the first implementation direct.', 'implementer');
    const paused = await tasks.run(id);
    assert.equal(paused.stopReason?.code, 'USER_PAUSED', paused.note);
    assert.equal(paused.guidance.length, 1);
    const reopened = new Store(f.store.path);
    try {
      const resumed = new GuidedTasks(reopened, config);
      assert.equal(resumed.get(id).guidance[0]!.target, 'next_agent');
      const done = await resumed.run(id);
      assert.equal(done.status, 'complete', done.note);
      assert.deepEqual(done.guidance, []);
    } finally {
      reopened.close();
    }
    assert.equal(implementations, 1);
    assert.equal(reviews, 1);
  },
);
