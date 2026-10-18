// Guided task tests: revising approved recipes and preserving partial or delivered work.
import type { Execution } from '../src/execution/execution-state.js';
import type { Workspace } from '../src/repository/workspaces.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks, guidedDecisionKey } from '../src/orchestration/guided-tasks.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import { renderReport } from '../src/reporting/report.js';
import { windows, git, services, fixture } from './helpers/guided-tasks.js';

test(
  'revising an approved recipe preserves partial edits, rejects stale decisions and requires every fresh gate',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    const submitted = await f.tasks.authorize(id),
      oldKey = guidedDecisionKey(submitted);
    const before = readFileSync(join(f.plan.workspace.path, 'greeting.js'), 'utf8');
    const input = structuredClone(submitted.plan);
    input.brief.title = 'Revised greeting';
    input.slices[0]!.message = 'Deliver revised greeting';
    const revised = await new GuidedTasks(f.store, { expectedState: oldKey }).revise(id, input);
    assert.equal(revised.version, 2);
    assert.equal(revised.status, 'draft');
    assert.equal(revised.approvedDigest, null);
    assert.equal(revised.workspaceId, submitted.workspaceId);
    assert.equal(readFileSync(join(f.plan.workspace.path, 'greeting.js'), 'utf8'), before);
    assert.equal(new Workflow(f.store).get(id).evidence.length, 0);
    assert.equal(f.store.execution<Execution>(submitted.executionId!).phase, 'closed');
    assert.equal(f.store.workspace<Workspace>(revised.workspaceId!).version, 2);
    assert.throws(
      () => new GuidedTasks(f.store, { expectedState: oldKey }).approve(id, 2, revised.digest),
      /changed since/,
    );
    assert.throws(() => f.tasks.approve(id, 1, submitted.digest), /current draft/);
    await assert.rejects(f.tasks.authorize(id), /Approve/);
    f.tasks.approve(id, 2, revised.digest);
    const ready = await f.tasks.run(id);
    assert.equal(ready.status, 'awaiting_scope', ready.note);
    assert.notEqual(ready.executionId, submitted.executionId);
    const assessed = await f.tasks.authorize(id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    const done = await f.tasks.assess(id, 'passed', 'Reinspected the revised task and its single output statement');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(f.store.workspaces().length, 1);
    assert.match(renderReport(f.store, id), /guided.revised/);
  },
);

test(
  'revisions reject changed workspace identity and approval cannot run against changed retained bytes',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    const checkpoint = await f.tasks.run(id);
    const wrong = structuredClone(checkpoint.plan);
    wrong.workspace.path = join(f.root, 'other');
    await assert.rejects(f.tasks.revise(id, wrong), /preserve the repository/);
    assert.equal(f.tasks.get(id).version, 1);
    assert.equal(f.tasks.get(id).owner, null);
    const revised = await f.tasks.revise(id, checkpoint.plan);
    f.tasks.approve(id, revised.version, revised.digest);
    writeFileSync(join(f.plan.workspace.path, 'greeting.js'), "console.log('unapproved edit');\n");
    const blocked = await f.tasks.run(id);
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.note, /changed since revised plan/);
    assert.equal(f.store.executions().length, 1);
  },
);

test(
  'a revision preserves delivered slice commits while continuing from explicitly approved partial edits',
  windows,
  async t => {
    const f = fixture(t),
      criteria = ['Print hello world with a newline', 'Preserve the greeting while completing the follow-up'];
    const plan = {
      ...f.plan,
      implementation: { provider: 'claude' },
      brief: {
        ...f.plan.brief,
        criteria,
        slices: [
          { title: 'Greeting', plan: 'Implement greeting', criteria: [criteria[0]!] },
          { title: 'Follow-up', plan: 'Verify greeting again', criteria: [criteria[1]!] },
        ],
      },
      slices: [f.plan.slices[0]!, { ...f.plan.slices[0]!, mode: 'no_change', scope: { files: [] } }],
    };
    const task = f.tasks.create(plan),
      id = task.id;
    f.tasks.approve(id, 1, task.guided!.digest);
    await f.tasks.run(id);
    await f.tasks.authorize(id);
    const second = await f.tasks.assess(id, 'passed', 'The first slice uses one direct statement');
    assert.equal(second.sliceIndex, 1);
    assert.equal(second.status, 'awaiting_scope', second.note);
    const delivered = new Workflow(f.store).get(id).slice!.completed[0]!;
    writeFileSync(join(f.plan.workspace.path, 'greeting.js'), "console.log('hello world'); // partial follow-up\n");
    const input = structuredClone(second.plan);
    input.brief.slices![1]!.plan = 'Finish the approved follow-up edit';
    input.slices[1]!.mode = 'commit';
    input.slices[1]!.scope = { files: ['greeting.js'] };
    input.slices[1]!.message = 'Finish follow-up';
    const wrong = structuredClone(input);
    wrong.slices[0]!.message = 'Rewrite delivered history';
    await assert.rejects(f.tasks.revise(id, wrong), /Delivered slices cannot/);
    const revised = await f.tasks.revise(id, input);
    assert.equal(revised.sliceIndex, 1);
    assert.equal(revised.status, 'draft');
    assert.deepEqual(new Workflow(f.store).get(id).slice!.completed, [delivered]);
    assert.equal(git(f.plan.workspace.path, 'rev-parse', 'HEAD'), delivered.head);
    const tasks = new GuidedTasks(f.store, services("console.log('hello world'); // completed follow-up\n"));
    tasks.approve(id, 2, revised.digest);
    const scope = await tasks.run(id);
    assert.equal(scope.status, 'awaiting_scope', scope.note);
    const assessed = await tasks.authorize(id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    const done = await tasks.assess(id, 'passed', 'The follow-up preserves the delivered contract');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(f.plan.workspace.path, 'rev-parse', 'HEAD^'), delivered.head);
    assert.deepEqual(guidedTaskView(f.store, id).checks.at(-1)!.spec.criteria, criteria);
  },
);
