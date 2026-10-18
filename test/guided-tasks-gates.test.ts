// Guided task tests: plan approval, real gates and verified local delivery across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedTaskView, renderGuidedTask } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import { runCheckProcess } from '../src/process/check-process.js';
import type { ImplementationRun } from '../src/execution/implementations.js';
import { renderReport } from '../src/reporting/report.js';
import { windows, cli, message, review, git, services, fixture } from './helpers/guided-tasks.js';

test('guided agent turns have no deadline and plans cannot set one', windows, async t => {
  const f = fixture(t);
  const fake = services();
  const tasks = new GuidedTasks(f.store, {
    ...fake,
    implementationRunner: async options => {
      assert.equal(options.timeoutMs, 0);
      return fake.implementationRunner!(options);
    },
    connector: async () => ({
      turn: async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  });
  assert.throws(
    () => tasks.create({ ...f.plan, implementation: { provider: 'codex', timeoutMs: 100 } }),
    /allowed fields: provider, model/,
  );
  const task = tasks.create(f.plan),
    digest = task.guided!.digest;
  tasks.approve(task.id, 1, digest);
  await tasks.run(task.id);
  await tasks.authorize(task.id);
  assert.equal(tasks.get(task.id).status, 'awaiting_assessment');
  assert.equal(tasks.get(task.id).stopReason?.code, 'ASSESSMENT_REQUIRED');
  await tasks.assess(task.id, 'passed', 'Direct output statement, no unnecessary abstraction');
  assert.equal(tasks.get(task.id).status, 'complete', tasks.get(task.id).note);
  assert.equal(tasks.get(task.id).digest, digest);
});

test(
  'guided plan approval binds the complete recipe and CLI setup reaches a scope checkpoint without inference',
  windows,
  async t => {
    const f = fixture(t),
      file = join(f.root, 'plan.json');
    writeFileSync(file, JSON.stringify(f.plan));
    const invoke = (...args: string[]) =>
      execFileSync(process.execPath, [cli, '--db', f.store.path, '--json', ...args], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe',
      });
    const created = JSON.parse(invoke('task-new', file)) as ReturnType<typeof guidedTaskView>;
    assert.equal(created.state.status, 'draft');
    assert.equal(created.state.stopReason?.code, 'APPROVAL_REQUIRED');
    assert.equal(created.state.plan.workspace.base, git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(created.state.plan.slices[0]!.validation.file, process.execPath);
    assert.equal(f.store.workspaces().length, 0);
    assert.equal(f.store.sessions().length, 0);
    assert.throws(() => invoke('task-approve', created.task.id, '1', 'wrong'));
    await assert.rejects(f.tasks.run(created.task.id), /Approve/);
    invoke('task-approve', created.task.id, '1', created.state.digest);
    const prepared = JSON.parse(invoke('task-run', created.task.id)) as ReturnType<typeof guidedTaskView>;
    assert.equal(prepared.state.status, 'awaiting_scope');
    assert.equal(prepared.implementations.length, 0);
    assert.equal(prepared.workspace!.baseCommit, created.state.plan.workspace.base);
    assert.match(renderGuidedTask(f.store, created.task.id, true), /Use one direct output statement/);
    assert.match(prepared.next, /task-authorize/);
    assert.equal(prepared.state.owner, null);
    await assert.rejects(f.tasks.run(created.task.id), /awaiting_scope/);
  },
);

test('guided task connects real gates and a verified local commit across controller restarts', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  const second = new Store(f.store.path);
  try {
    const tasks = new GuidedTasks(second, services());
    const checkpoint = await tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(new Workflow(second).get(id).evidence.filter(item => item.outcome === 'passed').length, 1);
    assert.equal(second.implementations<ImplementationRun>(checkpoint.executionId!).length, 1);
    assert.match(renderGuidedTask(second, id, true), /validated/);
    assert.throws(() => tasks.approve(id, 1, checkpoint.digest), /draft/);
    const done = await tasks.assess(
      id,
      'passed',
      'One direct statement follows the repository rule; no unnecessary abstractions.',
    );
    assert.equal(done.status, 'complete', done.note);
    assert.equal(done.owner, null);
    const view = guidedTaskView(second, id);
    assert.equal(view.task.phase, 'complete');
    assert.equal(view.deliveries.length, 1);
    assert.equal(view.deliveries[0]!.phase, 'delivered');
    assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD^'), done.plan.workspace.base);
    assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
    assert.match(renderReport(second, id), /guided.scope_authorized/);
    const turns = second.sessions().length;
    await assert.rejects(tasks.run(id), /complete/);
    await assert.rejects(tasks.assess(id, 'passed', 'repeat'), /No simplification/);
    assert.equal(second.sessions().length, turns);
  } finally {
    second.close();
  }
});

test(
  'large tracked text reaches verified delivery while ignored output stays outside its artifact',
  windows,
  async t => {
    const f = fixture(t),
      padding = '// padding for a large ordinary source file\n'.repeat(10000);
    writeFileSync(join(f.repo, 'greeting.js'), "console.log('hello');\n" + padding);
    writeFileSync(join(f.repo, '.gitignore'), 'generated/\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'Large source baseline');
    const config = services();
    config.implementationRunner = options =>
      runCheckProcess({
        ...options,
        args: [
          '-e',
          `
    const fs = require('node:fs');
    fs.writeFileSync('greeting.js', fs.readFileSync('greeting.js', 'utf8').replace("console.log('hello')", "console.log('hello world')"));
    fs.mkdirSync('generated', {recursive:true}); fs.writeFileSync('generated/build.bin', Buffer.alloc(2*1024*1024));
    fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},
      result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));
  `,
        ],
      });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create(f.plan);
    tasks.approve(task.id, task.version, task.guided!.digest);
    const scope = await tasks.run(task.id);
    assert.equal(scope.status, 'awaiting_scope', scope.note);
    const edited = await tasks.authorize(task.id);
    assert.equal(edited.status, 'awaiting_assessment', edited.note);
    const done = await tasks.assess(
      task.id,
      'passed',
      'One direct output statement changed; the retained comment text is unchanged.',
    );
    assert.equal(done.status, 'complete', done.note);
    const workspace = guidedTaskView(f.store, task.id).workspace!.path!;
    assert.equal(readFileSync(join(workspace, 'greeting.js'), 'utf8'), "console.log('hello world');\n" + padding);
    assert.equal(git(workspace, 'show', 'HEAD:greeting.js'), ("console.log('hello world');\n" + padding).trim());
    assert.equal(git(workspace, 'status', '--porcelain'), '');
  },
);
