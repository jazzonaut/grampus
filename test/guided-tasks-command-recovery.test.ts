// A child command with uncertain settlement keeps its parent implementation locked until recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('an uncertain diagnostic prevents parent success and any command replay', windows, async t => {
  const f = fixture(t),
    config = services();
  let dispatches = 0;
  config.implementationRunner = async options => {
    writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
    const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async () => {
      dispatches++;
      return {
        reason: 'supervisor_lost',
        exitCode: null,
        exitConfirmed: false,
        stdout: '',
        stderr: '',
        outputTruncated: false,
      };
    });
    await assert.rejects(commands.run('validation'), /recovery/);
    assert.equal(commands.running, true, 'native writes remain suspended while the command exit is uncertain');
    await assert.rejects(commands.run('validation'), /unsettled/);
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, quality: { passes: [] }, workflowPolicy: { mode: 'automatic' } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const result = await tasks.run(task.id);
  assert.equal(result.stopReason?.code, 'OPERATION_NEEDS_RECOVERY', result.note);
  assert.equal(dispatches, 1);
  assert.ok(f.store.lease(result.workspaceId!));
  assert.equal(f.store.deliveries(result.executionId!).length, 0);
});
