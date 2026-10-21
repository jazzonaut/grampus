// Expensive diagnostic families have one slice-wide allowance, including focused selections and new attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('failed broad diagnostics require focus and all selections share a durable attempt budget', windows, async t => {
  const f = fixture(t),
    config = services();
  let calls = 0;
  config.implementationRunner = async options => {
    const runner = async () => {
      calls++;
      return {
        reason: 'exited',
        exitCode: 1,
        exitConfirmed: true,
        stdout: 'repair the assertion',
        stderr: '',
        outputTruncated: false,
      };
    };
    const make = () => new ImplementationCommands(f.store, options.receipt!.checkId, runner);
    const name = 'diagnostic:Browser';
    assert.equal(((await make().run(name, { files: ['greeting.js'] })) as { phase: string }).phase, 'failed');
    writeFileSync(join(options.cwd, 'greeting.js'), "console.log('repair one');\n");
    await assert.rejects(make().run(name), /focus|narrow/i);
    await assert.rejects(make().run(name, { files: ['greeting.js'] }), /focus|narrow/i);
    await make().run(name, { parameters: { grep: 'failing case' } });
    writeFileSync(join(options.cwd, 'greeting.js'), "console.log('repair two');\n");
    await make().run(name, { parameters: { grep: 'failing case' } });
    await assert.rejects(make().run(name, { parameters: { grep: 'different case' } }), /allowance|budget/i);
    assert.equal(calls, 3);
    const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
    tasks.pause(execution.taskId);
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    quality: { passes: [] },
    slices: [
      {
        ...f.plan.slices[0],
        diagnostics: [
          {
            name: 'Browser',
            file: 'node',
            args: ['-e', ''],
            timeoutMs: 15000,
            selection: { parameters: [{ name: 'grep', flag: '--grep' }], fileSuffixes: ['.js'] },
          },
        ],
      },
    ],
  });
  assert.equal(task.guided!.plan.slices[0]!.diagnostics[0]!.maxRuns, 3);
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.stopReason?.code, 'DIAGNOSTIC_ALLOWANCE_REQUIRED', state.note);
});
