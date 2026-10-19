// Guided task tests: acceptance, workspace creation, selected context and no-change delivery.
import type { Workspace } from '../src/repository/workspaces.js';
import type { Execution } from '../src/execution/execution-state.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import { renderReport } from '../src/reporting/report.js';
import { windows, cli, review, git, services, fixture } from './helpers/guided-tasks.js';

test('guided acceptance verifies JSON values and file bytes through supervised delivery', windows, async t => {
  const f = fixture(t),
    source = "console.log('hello world');\n";
  const task = f.tasks.create({
      ...f.plan,
      slices: [
        {
          ...f.plan.slices[0],
          acceptance: {
            file: 'node',
            args: ['-e', 'console.log(JSON.stringify({ok:true, count:2}))'],
            timeoutMs: 15000,
            expectations: {
              stdoutJson: { count: 2, ok: true },
              stderr: '',
              files: [{ path: 'greeting.js', content: source }],
            },
          },
        },
      ],
    }),
    id = task.id;
  f.tasks.approve(id, 1, task.guided!.digest);
  await f.tasks.run(id);
  await f.tasks.authorize(id);
  const done = await f.tasks.assess(id, 'passed', 'Verified the output statement and captured file observations');
  assert.equal(done.status, 'complete', done.note);
  assert.ok(guidedTaskView(f.store, id).checks.at(-1)!.spec.expectations?.files?.length);
});

test(
  'failed guided workspace creation releases only unused metadata and waits for explicit continuation',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create(),
      branch = `grampus/${id}`;
    git(f.repo, 'branch', branch);
    assert.throws(() =>
      execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-run', id], { stdio: 'pipe', windowsHide: true }),
    );
    assert.equal(f.tasks.get(id).status, 'recovery_required');
    assert.equal(f.tasks.get(id).stopReason?.code, 'RECOVERY_REQUIRED');
    const released = await f.tasks.releaseWorkspace(id);
    assert.equal(released.status, 'ready');
    assert.equal(released.stopReason, null);
    assert.equal(released.pending, null);
    assert.equal(released.owner, null);
    assert.equal(f.store.workspaces<Workspace>()[0]!.phase, 'released');
    assert.equal(f.store.executions().length, 0);
    const continued = await f.tasks.run(id);
    assert.equal(continued.status, 'awaiting_scope', continued.note);
    assert.equal(f.store.executions().length, 1);
    assert.equal(git(f.repo, 'rev-parse', branch), continued.plan.workspace.base);
  },
);

test('a failed quality assessment is retained and cannot start independent review or delivery', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  const checkpoint = await f.tasks.authorize(id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const failed = await f.tasks.assess(id, 'skipped', 'Inspection still outstanding');
  assert.equal(failed.status, 'blocked', failed.note);
  assert.equal(failed.stopReason?.code, 'QUALITY_ASSESSMENT_FAILED');
  assert.ok(
    new Workflow(f.store)
      .get(id)
      .evidence.some(item => item.kind === 'quality' && item.pass === 'simplification' && item.outcome === 'skipped'),
  );
  assert.equal(f.store.executions<Execution>().filter(item => item.role === 'review').length, 0);
  assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  await assert.rejects(f.tasks.run(id), /blocked/);
});

test('guided delivery verifies a larger repository while supplying only selected text context', windows, async t => {
  const f = fixture(t),
    asset = Buffer.alloc(1024 * 1024, 255);
  writeFileSync(join(f.repo, 'asset.bin'), asset);
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Existing binary asset');
  const plan = { ...f.plan, context: { files: ['greeting.js'] } };
  let reviewed = false;
  const configured = services();
  configured.connector = async () => ({
    turn: async prompt => {
      assert.match(prompt, /"omittedFiles":1/);
      assert.match(prompt, /NOT reviewed/);
      reviewed = true;
      return { status: 'completed', reply: review, usage: null, error: null };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, configured),
    task = tasks.create(plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const done = await tasks.assess(
    task.id,
    'passed',
    'One direct output statement, inspected with the existing repository instructions.',
  );
  assert.equal(done.status, 'complete', done.note);
  assert.equal(reviewed, true);
  const view = guidedTaskView(f.store, task.id);
  assert.deepEqual(readFileSync(join(view.workspace!.path!, 'asset.bin')), asset);
  assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
  assert.match(renderReport(f.store, task.id), /omittedFiles/);
});

test('stale scopes stop before dispatch while repository size is independent of selected context', windows, async t => {
  const f = fixture(t);
  let calls = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: async () => {
      calls++;
      throw new Error('Unexpected dispatch');
    },
  });
  const id = f.create();
  await tasks.run(id);
  const state = tasks.get(id),
    workspace = f.store.workspace<Workspace>(state.workspaceId!);
  writeFileSync(join(workspace.path!, 'greeting.js'), "console.log('external change');\n");
  const stopped = await tasks.authorize(id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'IMPLEMENTATION_FAILED');
  assert.equal(calls, 0);
  writeFileSync(join(f.repo, 'large.txt'), 'x'.repeat(256 * 1024));
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Too large for guided review');
  const larger = tasks.create({
    ...f.plan,
    context: { files: ['greeting.js'] },
    workspace: { ...f.plan.workspace, path: join(f.root, 'another-workspace') },
  });
  assert.ok(larger.guided!.plan.context.totalBytes > 256 * 1024);
  assert.deepEqual(larger.guided!.plan.context.files, ['AGENTS.md', 'greeting.js']);
});

test('no-change workflow runs every gate without implementation inference or a commit', windows, async t => {
  const f = fixture(t);
  const plan = structuredClone(f.plan);
  plan.brief.outcome = 'Confirm the existing hello greeting';
  plan.brief.criteria = ['Print hello with a newline'];
  plan.slices[0]!.validation.args = ['greeting.js'];
  plan.slices[0]!.acceptance.expectedStdout = 'hello\n';
  const input = { ...plan, slices: [{ ...plan.slices[0]!, scope: { files: [] }, mode: 'no_change' }] };
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: async () => {
      throw new Error('No-change cannot call implementation');
    },
  });
  const task = tasks.create(input);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  assert.equal(f.store.implementations(checkpoint.executionId!).length, 0);
  const done = await tasks.assess(task.id, 'passed', 'Existing fixture already uses one direct output statement');
  assert.equal(done.status, 'complete', done.note);
  const view = guidedTaskView(f.store, task.id);
  assert.equal(view.deliveries[0]!.outcome, 'no_change');
  assert.equal(view.deliveries[0]!.commit, null);
  assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), done.plan.workspace.base);
});
