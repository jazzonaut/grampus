// Guided task tests: preparation input protection, recovery and no-change preparation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided-tasks.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import { runCheckProcess } from '../src/process/check-process.js';
import { Checks, type RepositoryCheck } from '../src/verification/checks.js';
import { windows, preparation, git, services, fixture } from './helpers/guided-tasks.js';

for (const stage of ['initial', 'slice'] as const)
  test(`${stage} preparation cannot change unauthorized inputs or be used as validation`, windows, async t => {
    const f = fixture(t),
      command = preparation("require('node:fs').writeFileSync('AGENTS.md','unauthorized');");
    const task = f.tasks.create({
      ...f.plan,
      ...(stage === 'initial' ? { preparation: command } : {}),
      slices: [{ ...f.plan.slices[0], ...(stage === 'slice' ? { preparation: command } : {}) }],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    let result = await f.tasks.run(task.id);
    if (stage === 'slice') result = await f.tasks.authorize(task.id);
    assert.equal(result.status, 'blocked', result.note);
    assert.match(result.note, /changed repository inputs|Git state or repository instructions/);
    const checks = f.store.checks<RepositoryCheck>(result.executionId!);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.purpose, 'preparation');
    await assert.rejects(f.tasks.retry(task.id), /changed repository inputs|Git state or repository instructions/);
    assert.equal(f.store.checks(result.executionId!).length, 1);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
  });

test('a passing preparation cannot replace validation evidence', windows, async t => {
  const f = fixture(t),
    task = f.tasks.create({ ...f.plan, preparation: preparation("console.log('ready')") });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const scope = await f.tasks.run(task.id);
  const check = f.store.checks<RepositoryCheck>(scope.executionId!)[0]!;
  await assert.rejects(new Checks(f.store).finish(scope.executionId!, check.id), /preparation is not validation/);
  assert.equal(
    new Workflow(f.store)
      .get(task.id)
      .evidence.some(evidence => evidence.kind === 'validation' && evidence.outcome === 'passed'),
    false,
  );
});

test('recovery adopts a completed preparation without replaying it or starting implementation', windows, async t => {
  const f = fixture(t),
    marker = join(f.root, 'restore-count');
  const task = f.tasks.create({
    ...f.plan,
    preparation: preparation(
      `const fs=require('node:fs'),p=${JSON.stringify(marker)};fs.writeFileSync(p,String(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1));`,
    ),
  });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const file = join(f.root, 'crash-preparation.mjs');
  writeFileSync(
    file,
    `import {Store} from ${JSON.stringify(new URL('../src/persistence/store.js', import.meta.url).href)};
    import {GuidedTasks} from ${JSON.stringify(new URL('../src/orchestration/guided-tasks.js', import.meta.url).href)};
    const store=new Store(${JSON.stringify(f.store.path)}),append=store.append.bind(store);
    store.append=(id,version,type,data)=>{if(type==='guided.step_finished'&&data.stage==='scope')process.exit(29);append(id,version,type,data)};
    await new GuidedTasks(store).run(${JSON.stringify(task.id)});throw new Error('Expected controller exit');`,
  );
  assert.throws(
    () => execFileSync(process.execPath, [file], { windowsHide: true, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 29,
  );
  assert.equal(f.tasks.get(task.id).pending!.stage, 'preparation');
  const recovered = await f.tasks.recover(task.id);
  assert.equal(recovered.status, 'ready', recovered.note);
  assert.equal(recovered.stage, 'scope');
  assert.equal(readFileSync(marker, 'utf8'), '1');
  const scope = await f.tasks.run(task.id);
  assert.equal(scope.status, 'awaiting_scope', scope.note);
  assert.equal(readFileSync(marker, 'utf8'), '1');
  assert.equal(f.store.implementations(scope.executionId!).length, 0);
});

test('interrupted preparation remains retryable without starting a new attempt', windows, async t => {
  const f = fixture(t);
  let first = true;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    preparationRunner: async options => {
      if (first) {
        first = false;
        return {
          reason: 'interrupted',
          exitCode: null,
          exitConfirmed: true,
          stdout: '',
          stderr: 'Stopped during restore',
          outputTruncated: false,
        };
      }
      return runCheckProcess(options);
    },
  });
  const task = tasks.create({ ...f.plan, preparation: preparation("console.log('restored')") });
  tasks.approve(task.id, 1, task.guided!.digest);
  const interrupted = await tasks.run(task.id);
  assert.equal(interrupted.status, 'blocked', interrupted.note);
  assert.equal(interrupted.owner, null);
  assert.equal(f.store.checks<RepositoryCheck>(interrupted.executionId!)[0]!.phase, 'interrupted');
  const retried = await tasks.retry(task.id);
  assert.equal(retried.status, 'awaiting_scope', retried.note);
  assert.equal(retried.executionId, interrupted.executionId);
});

test(
  'unconfirmed preparation shutdown retains ownership and cannot retry or start implementation',
  windows,
  async t => {
    const f = fixture(t);
    let dispatches = 0;
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      preparationRunner: async () => {
        dispatches++;
        return {
          reason: 'supervisor_failed',
          exitCode: null,
          exitConfirmed: false,
          stdout: '',
          stderr: 'Shutdown unconfirmed',
          outputTruncated: false,
        };
      },
    });
    const task = tasks.create({ ...f.plan, preparation: preparation("console.log('restore')") });
    tasks.approve(task.id, 1, task.guided!.digest);
    const uncertain = await tasks.run(task.id);
    assert.equal(uncertain.status, 'recovery_required', uncertain.note);
    assert.ok(uncertain.owner);
    assert.ok(uncertain.pending);
    assert.ok(f.store.lease(uncertain.workspaceId!));
    assert.equal(f.store.implementations(uncertain.executionId!).length, 0);
    await assert.rejects(tasks.retry(task.id), /recover uncertain/);
    await assert.rejects(tasks.run(task.id), /recovery_required/);
    await assert.rejects(tasks.recover(task.id), /still alive|unverifiable/);
    assert.equal(dispatches, 1);
  },
);

test(
  'no-change slices can prepare prerequisites while preserving every gate and the original commit',
  windows,
  async t => {
    const f = fixture(t),
      base = git(f.repo, 'rev-parse', 'HEAD');
    const task = f.tasks.create({
      ...f.plan,
      brief: {
        title: 'Verify existing greeting',
        outcome: 'Confirm hello with a newline',
        criteria: ['Print hello with a newline'],
        plan: 'Prepare and independently verify without editing',
      },
      preparation: preparation("console.log('prerequisites ready')"),
      slices: [
        {
          scope: { files: [] },
          mode: 'no_change',
          validation: preparation(
            "require('node:assert/strict').equal(require('node:fs').readFileSync('greeting.js','utf8'),\"console.log('hello');\\n\")",
          ),
          acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' },
          message: 'Verify existing greeting',
        },
      ],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    await f.tasks.run(task.id);
    const checkpoint = await f.tasks.authorize(task.id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(f.store.implementations(checkpoint.executionId!).length, 0);
    const done = await f.tasks.assess(task.id, 'passed', 'The existing direct output needs no edits');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(guidedTaskView(f.store, task.id).deliveries[0]!.outcome, 'no_change');
    assert.equal(git(guidedTaskView(f.store, task.id).workspace!.path!, 'rev-parse', 'HEAD'), base);
  },
);
