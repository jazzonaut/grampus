// Guided task tests: adopting lost implementation, delivery and assessment results after a controller exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import type { ImplementationRun } from '../src/execution/implementations.js';
import { windows, git, fixture, crashProgram } from './helpers/guided-tasks.js';

test(
  'a lost completed implementation is adopted without replay and continues only on explicit task-run',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    crashProgram(f, 'authorize', 'validation', id);
    const before = f.tasks.get(id);
    assert.equal(before.pending!.stage, 'implementation');
    assert.ok(before.owner);
    const runs = f.store.implementations<ImplementationRun>(before.executionId!);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.phase, 'completed');
    await assert.rejects(f.tasks.run(id), /running|uncertain/);
    const recovered = await f.tasks.recover(id);
    assert.equal(recovered.status, 'ready', recovered.note);
    assert.equal(recovered.stage, 'validation');
    assert.equal(recovered.owner, null);
    assert.equal(f.store.implementations(before.executionId!).length, 1);
    assert.equal(f.store.checks(before.executionId!).length, 0);
    await assert.rejects(f.tasks.recover(id), /No guided recovery/);
    const checkpoint = await f.tasks.run(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    const done = await f.tasks.assess(id, 'passed', 'Inspected preserved completed edit and real validation');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(f.store.implementations(before.executionId!).length, 1);
  },
);

for (const journalFailure of [false, true])
  test(
    `a lost verified delivery after ${journalFailure ? 'journal failure' : 'controller exit'} is adopted once without inference or Git replay`,
    windows,
    async t => {
      const f = fixture(t),
        id = f.create();
      await f.tasks.run(id);
      await f.tasks.authorize(id);
      crashProgram(f, 'assess', 'complete', id, journalFailure);
      const before = f.tasks.get(id);
      assert.equal(before.pending!.stage, 'delivery');
      const view = guidedTaskView(f.store, id),
        head = git(view.workspace!.path!, 'rev-parse', 'HEAD');
      assert.equal(view.task.phase, 'complete');
      assert.equal(view.deliveries[0]!.phase, 'delivered');
      const sessions = f.store.sessions().length;
      const done = await f.tasks.recover(id);
      assert.equal(done.status, 'complete', done.note);
      assert.equal(done.owner, null);
      assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), head);
      assert.equal(f.store.deliveries(before.executionId!).length, 1);
      assert.equal(f.store.sessions().length, sessions);
      await assert.rejects(f.tasks.recover(id), /No guided recovery/);
    },
  );

test(
  'an explicit assessment entered before a controller exit remains bound and requires explicit continuation',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    const checkpoint = await f.tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    crashProgram(f, 'assess', 'assessment_input', id);
    const before = f.tasks.get(id);
    assert.equal(before.pending, null);
    assert.equal(before.assessments[0]!.summary, 'Offline explicit simplification');
    const recovered = await f.tasks.recover(id);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.stage, 'assessment');
    assert.equal(recovered.reviewId, null);
    assert.equal(
      new Workflow(f.store).get(id).evidence.filter(item => item.kind === 'quality' && item.outcome === 'passed')
        .length,
      0,
    );
    const done = await f.tasks.run(id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(
      new Workflow(f.store).get(id).evidence.find(item => item.kind === 'quality' && item.outcome === 'passed')!
        .summary,
      'Offline explicit simplification',
    );
  },
);
