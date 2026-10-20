// Guided task tests: execution ownership within a one-slot runner pool, shutdown, deletion-only retries and
// failing gate commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { runCheckProcess } from '../src/process/check-process.js';
import { RunnerPoolFullError } from '../src/orchestration/guided/runner-pool.js';
import { defaultSettings, useSettings } from '../src/config/settings.js';
import { windows, cli, message, git, services, fixture, crashProgram } from './helpers/guided-tasks.js';

/** Limits the runner pool to one slot for one test, so a second task's claim is refused. */
function oneSlot(t: { after(fn: () => void): void }): void {
  useSettings({ ...defaultSettings(), maxConcurrentTasks: 1 });
  t.after(() => useSettings(defaultSettings()));
}

test('a one-slot pool admits one task and a cross-process stop request settles its actual tool', windows, async t => {
  oneSlot(t);
  const f = fixture(t),
    id = f.create();
  const other = f.tasks.create({
    ...f.plan,
    workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') },
  });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  let started!: () => void;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: options =>
      runCheckProcess({
        ...options,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        started: (kind, pid) => {
          options.started(kind, pid);
          if (kind === 'tool') started();
        },
      }),
  });
  await tasks.run(id);
  const running = tasks.authorize(id);
  await entered;
  await assert.rejects(tasks.run(other.id), RunnerPoolFullError);
  await assert.rejects(tasks.recover(id), /still alive/);
  execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-stop', id], { windowsHide: true, stdio: 'pipe' });
  const stopped = await running;
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'IMPLEMENTATION_INTERRUPTED');
  assert.equal(stopped.owner, null);
  assert.equal(f.store.implementations(stopped.executionId!)[0]!.phase, 'interrupted');
  assert.equal(f.store.lease(stopped.workspaceId!), null);
  const prepared = await tasks.run(other.id);
  assert.equal(prepared.status, 'awaiting_scope', prepared.note);
  assert.equal(prepared.stopReason?.code, 'SCOPE_AUTHORIZATION_REQUIRED');
});

test('unknown native shutdown keeps its runner slot and cannot admit another guided task', windows, async t => {
  oneSlot(t);
  const f = fixture(t),
    id = f.create();
  const other = f.tasks.create({
    ...f.plan,
    workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') },
  });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  const tasks = new GuidedTasks(f.store, {
    implementationRunner: async () => ({
      reason: 'supervisor_lost',
      exitCode: null,
      exitConfirmed: false,
      stdout: '',
      stderr: '',
      outputTruncated: false,
    }),
  });
  await tasks.run(id);
  const uncertain = await tasks.authorize(id);
  assert.equal(uncertain.status, 'recovery_required');
  assert.equal(uncertain.stopReason?.code, 'OPERATION_NEEDS_RECOVERY');
  assert.ok(uncertain.owner);
  assert.ok(uncertain.pending);
  assert.ok(f.store.lease(uncertain.workspaceId!));
  await assert.rejects(tasks.run(other.id), /1 of 1 guided tasks are already running/);
  await assert.rejects(tasks.retry(id), /recover uncertain/);
  await assert.rejects(tasks.recover(id), /still alive/);
});

test(
  'deletion-only retries validate retained deletion with fresh gates and no empty editing policy',
  windows,
  async t => {
    const f = fixture(t),
      marker = join(f.root, 'validation-attempted');
    let implementations = 0;
    const configured = services();
    configured.implementationRunner = options => {
      implementations++;
      return runCheckProcess({
        ...options,
        args: [
          '-e',
          `const fs=require('node:fs');fs.unlinkSync('greeting.js');
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))},JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));`,
        ],
      });
    };
    const tasks = new GuidedTasks(f.store, configured);
    const task = tasks.create({
      ...f.plan,
      brief: {
        title: 'Remove greeting',
        outcome: 'Remove the obsolete greeting',
        criteria: ['greeting.js is absent'],
        plan: 'Delete, validate, review and deliver',
      },
      slices: [
        {
          scope: { files: [], delete: ['greeting.js'] },
          validation: {
            file: 'node',
            args: [
              '-e',
              `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'attempted');process.exit(7)};require('node:assert/strict').equal(fs.existsSync('greeting.js'),false);`,
            ],
          },
          acceptance: [
            {
              file: 'node',
              args: [
                '-e',
                "require('node:assert/strict').equal(require('node:fs').existsSync('greeting.js'),false);console.log('absent');",
              ],
              expectedStdout: 'absent\n',
            },
          ],
          message: 'Remove obsolete greeting',
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    await tasks.run(task.id);
    const failed = await tasks.authorize(task.id);
    assert.equal(failed.status, 'blocked', failed.note);
    assert.equal(failed.stopReason?.code, 'CHECK_FAILED_SUPERVISED');
    const retried = await tasks.retry(task.id);
    assert.equal(retried.status, 'awaiting_scope', retried.note);
    assert.notEqual(retried.executionId, failed.executionId);
    assert.equal(retried.policy, null);
    const assessed = await tasks.authorize(task.id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    assert.equal(implementations, 1);
    const done = await tasks.assess(
      task.id,
      'passed',
      'The retained deletion is complete and fresh validation confirms absence',
    );
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(guidedTaskView(f.store, task.id).workspace!.path!, 'status', '--porcelain'), '');
    assert.equal(guidedTaskView(f.store, task.id).deliveries[0]!.outcome, 'committed');
  },
);

for (const gate of ['validation', 'acceptance'] as const)
  test(`a failing ${gate} command is retained and cannot reach delivery or replay itself`, windows, async t => {
    const f = fixture(t);
    if (gate === 'validation') f.plan.slices[0]!.validation.args = ['-e', 'process.exit(7)'];
    else f.plan.slices[0]!.acceptance[0]!.expectedStdout = 'unexpected output\n';
    const id = f.create();
    await f.tasks.run(id);
    let result = await f.tasks.authorize(id);
    if (gate === 'acceptance') {
      assert.equal(result.status, 'awaiting_assessment', result.note);
      result = await f.tasks.assess(id, 'passed', 'Inspected the one direct statement');
    }
    assert.equal(result.status, 'blocked', result.note);
    assert.equal(result.stopReason?.code, 'CHECK_FAILED_SUPERVISED');
    assert.equal(result.owner, null);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
    const view = guidedTaskView(f.store, id);
    assert.equal(view.checks.at(-1)!.phase, 'failed');
    if (gate === 'validation') assert.equal(view.checks.at(-1)!.result!.exitCode, 7);
    else assert.ok(view.task.evidence.some(item => item.kind === 'verification' && item.outcome === 'failed'));
    const attempts = f.store.implementations(result.executionId!).length,
      checks = view.checks.length;
    await assert.rejects(f.tasks.run(id), /blocked/);
    assert.equal(f.store.implementations(result.executionId!).length, attempts);
    assert.equal(f.store.checks(result.executionId!).length, checks);
  });

test('recovery refuses a completed result with a different file authorization', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  crashProgram(f, 'authorize', 'validation', id);
  const before = f.tasks.get(id),
    run = f.store.implementations(before.executionId!)[0]!;
  f.store.saveImplementation(run.id, run.executionId, { ...run, policy: { ...run.policy, files: ['AGENTS.md'] } });
  const refused = await f.tasks.recover(id);
  assert.equal(refused.status, 'recovery_required');
  assert.match(refused.note, /differs from the authorized file policy/);
  assert.equal(refused.stopReason?.code, 'RESULT_MISMATCH');
  assert.ok(refused.pending);
  assert.ok(refused.owner);
  assert.equal(f.store.checks(before.executionId!).length, 0);
  assert.equal(f.store.deliveries(before.executionId!).length, 0);
});

test('an implementation turn refused for its prompt budget blocks with its own reason', windows, async t => {
  const f = fixture(t);
  const refusal = 'Editable file context needs 300000 bytes but only 200000 of the 256 KiB turn prompt budget remain';
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    // The worker refuses before any provider starts and records the refusal as its turn result.
    implementationRunner: options =>
      runCheckProcess({
        ...options,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, ${JSON.stringify(
            JSON.stringify({
              id: options.receipt!.checkId,
              result: { status: 'failed', reply: null, usage: null, error: refusal, refused: 'prompt_budget' },
            }),
          )});`,
        ],
      }),
  });
  const task = tasks.create(f.plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const stopped = await tasks.authorize(task.id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'PROMPT_BUDGET_EXCEEDED');
  assert.equal(stopped.note, refusal);
});
