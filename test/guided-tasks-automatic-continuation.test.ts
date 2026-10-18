// Guided task tests: automatic acceptance repair and opting legacy plans into automatic continuation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided-tasks.js';
import { windows, review, services, fixture } from './helpers/guided-tasks.js';

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
            simplification: { outcome: 'passed', summary: 'Inspected the current single output statement.' },
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

test(
  'legacy plans can explicitly enable automatic continuation without changing their approved digest',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    config.connector = async () => ({
      turn: async () => ({
        status: 'completed',
        reply: {
          ...review,
          simplification: { outcome: 'passed', summary: 'The direct output statement needs no further abstraction.' },
        },
        usage: null,
        error: null,
      }),
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create(f.plan);
    // A saved plan predating workflow policy must keep its exact approval digest.
    delete task.guided!.plan.workflowPolicy;
    task.guided!.digest = (await import('../src/domain/guided-plan.js')).guidedPlanDigest(task.guided!.plan);
    f.store.save(task.id, task);
    tasks.approve(task.id, 1, task.guided!.digest);
    const scope = await tasks.run(task.id);
    assert.equal(scope.status, 'awaiting_scope');
    const done = await tasks.automate(task.id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(done.digest, scope.digest);
    assert.equal(done.automationEnabled, true);
  },
);
