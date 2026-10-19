// Missing progress evidence must persist a typed stop without spending another repair or delivering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, review, inlineImplementation, windows } from './helpers/guided-tasks.js';

test('a changed artifact without prior finding dispositions stops with a journaled reason', windows, async t => {
  const f = fixture(t);
  let edits = 0;
  let reviews = 0;
  const config = services();
  config.implementationRunner = options =>
    inlineImplementation(options, `// Attempt ${++edits}\nconsole.log('hello world');\n`);
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: {
        ...review,
        findings: [{ severity: 'blocking', description: `Defect ${++reviews}`, evidence: 'Concrete source' }],
      },
      usage: null,
      error: null,
    }),
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'REVIEW_PROGRESS_UNCONFIRMED');
  assert.equal(stopped.repairCycle.used, 1);
  assert.equal(edits, 2);
  assert.equal(f.store.deliveries(stopped.executionId!).length, 0);
  const decision = f.store.events(task.id, ['guided.repair_decided']).at(-1)!;
  assert.equal((decision.data as { action: string }).action, 'stop');
});
