// Guidance never schedules paid work and cannot disappear silently at local delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, review, windows } from './helpers/guided-tasks.js';

test(
  'unassigned guidance blocks delivery; cancellation resumes the verified attempt without another review',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let reviews = 0;
    config.connector = async () => ({
      turn: async () => {
        reviews++;
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: [] },
      brief: { ...f.plan.brief, outcome: 'Keep the existing greeting', criteria: ['Print hello with a newline'] },
      slices: [
        {
          ...f.plan.slices[0],
          mode: 'no_change',
          scope: { files: [] },
          validation: { file: 'node', args: ['--check', 'greeting.js'] },
          acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' },
        },
      ],
    });
    const id = task.id;
    tasks.approve(id, 1, task.guided!.digest);
    const queued = tasks.queueGuidance(id, 'If implementation runs, use a direct statement.', 'implementer');
    const stopped = await tasks.run(id);
    assert.equal(stopped.stopReason?.code, 'GUIDANCE_PENDING', stopped.note);
    assert.equal(stopped.stage, 'delivery');
    assert.equal(stopped.pending, null);
    assert.equal(stopped.owner, null);
    assert.equal(f.store.deliveries(stopped.executionId!).length, 0);
    assert.equal(f.store.implementations(stopped.executionId!).length, 0);
    const attempt = f.store.get(id).attempt!.id;
    tasks.cancelGuidance(id, queued.guidance[0]!.id);
    const done = await tasks.run(id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(f.store.get(id).attempt!.id, attempt);
    assert.equal(reviews, 1);
  },
);
