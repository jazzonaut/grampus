// Automatic final formatting joins an already dispatched diagnostic instead of racing its lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('final formatting waits for a pending diagnostic before starting its own command', windows, async t => {
  const f = fixture(t),
    config = services();
  config.implementationRunner = async options => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async () => {
      if (++calls === 1) {
        entered();
        await held;
      }
      return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
    });
    const diagnostic = commands.run('validation');
    await started;
    let finished = false;
    const finishing = commands.finish().finally(() => {
      finished = true;
    });
    void finishing.catch(() => {});
    await setImmediate();
    try {
      assert.equal(finished, false, 'final formatting must join the active command');
    } finally {
      release();
      await diagnostic;
      await finishing;
    }
    assert.equal(calls, 2);
    assert.equal(commands.running, false);
    const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
    tasks.pause(execution.taskId);
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    quality: { passes: [] },
    slices: [{ ...f.plan.slices[0], formatting: { name: 'Format', file: 'node', args: ['-e', ''], timeoutMs: 15000 } }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
});
