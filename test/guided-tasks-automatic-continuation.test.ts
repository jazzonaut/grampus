// Guided task tests: automatic acceptance repair with renewed evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { windows, review, services, fixture, lens } from './helpers/guided-tasks.js';

test(
  'automatic acceptance repair invalidates earlier evidence and resumes its independent reviewer',
  windows,
  async t => {
    const f = fixture(t);
    let implementations = 0,
      reviews = 0;
    const config = services();
    config.implementationRunner = options =>
      services(++implementations === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n")
        .implementationRunner!(options);
    config.connector = async (_provider, options) => ({
      turn: async () => {
        if (reviews++) assert.equal(options.providerSessionId, 'same-independent-reviewer');
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'same-independent-reviewer', model: 'fixture' },
        });
        return {
          status: 'completed',
          reply: {
            ...review,
            lenses: [lens('pass', 'Inspected the current single output statement.')],
          },
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({
        ...f.plan,
        workflowPolicy: { mode: 'automatic' },
        slices: [{ ...f.plan.slices[0], validation: { file: 'node', args: ['--check', 'greeting.js'] } }],
      });
    tasks.approve(task.id, 1, task.guided!.digest);
    const done = await tasks.run(task.id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(implementations, 2);
    assert.equal(reviews, 2);
    assert.ok(f.store.events(task.id).some(event => event.type === 'guided.acceptance_repair_requested'));
    assert.ok(
      f.store.get<any>(task.id).evidence.every((e: any) => e.attemptId === f.store.get<any>(task.id).attempt.id),
    );
  },
);
