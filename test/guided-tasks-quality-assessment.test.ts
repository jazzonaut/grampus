// Guided task tests: in supervised mode one human quality assessment covers every selected lens and
// is recorded as evidence for each; a plan without lenses has nothing to assess and no lens gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import type { Evidence } from '../src/domain/workflow.js';
import { windows, services, fixture } from './helpers/guided-tasks.js';

const recorded = (evidence: Evidence[]) =>
  evidence.filter(item => item.kind === 'quality' && !item.id.endsWith(':requested'));

test(
  'a supervised quality assessment covers every selected lens; without lenses there is nothing to assess',
  windows,
  async t => {
    const f = fixture(t);
    const tasks = new GuidedTasks(f.store, services());
    const task = tasks.create({ ...f.plan, quality: { passes: ['simplification', 'naming'] } });
    tasks.approve(task.id, 1, task.guided!.digest);
    await tasks.run(task.id);
    const checkpoint = await tasks.authorize(task.id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(checkpoint.stopReason?.code, 'ASSESSMENT_REQUIRED');
    assert.match(checkpoint.note, /simplification, naming/);
    const done = await tasks.assess(task.id, 'passed', 'One direct statement with a precise name');
    assert.equal(done.status, 'complete', done.note);
    assert.deepEqual(
      recorded(f.store.get(task.id).evidence).map(item => [item.pass, item.outcome, item.source, item.summary]),
      [
        ['simplification', 'passed', 'controller', 'One direct statement with a precise name'],
        ['naming', 'passed', 'controller', 'One direct statement with a precise name'],
      ],
    );

    const none = tasks.create({
      ...f.plan,
      workspace: { ...f.plan.workspace, path: join(f.root, 'no-passes') },
      quality: { passes: [] },
    });
    tasks.approve(none.id, 1, none.guided!.digest);
    await tasks.run(none.id);
    const finished = await tasks.authorize(none.id);
    assert.equal(finished.status, 'complete', finished.note);
    assert.ok(
      !f.store.events(none.id).some(event => (event.data as { status?: string })?.status === 'awaiting_assessment'),
    );
    assert.deepEqual(recorded(f.store.get(none.id).evidence), []);
    await assert.rejects(tasks.assess(none.id, 'passed', 'Nothing to assess'), /No quality assessment/);
  },
);
