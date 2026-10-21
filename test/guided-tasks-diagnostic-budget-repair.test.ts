// Repairing the slice must not grant another diagnostic allowance or replay its earlier requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedPlanDigest } from '../src/domain/guided-plan.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'a new repair attempt retains the approved diagnostic-family spending from its previous attempt',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let turns = 0,
      commandsRun = 0;
    config.implementationRunner = async options => {
      turns++;
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async () => {
        commandsRun++;
        return {
          reason: 'exited',
          exitCode: 1,
          exitConfirmed: true,
          stdout: 'inspect the failing assertion',
          stderr: '',
          outputTruncated: false,
        };
      });
      if (turns === 1) {
        await commands.run('diagnostic:Browser');
        return inlineImplementation(options, "console.log('needs repair');\n");
      }
      await assert.rejects(commands.run('diagnostic:Browser'), /budget exhausted/);
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
              maxRuns: 1,
              selection: { parameters: [], fileSuffixes: [] },
            },
          ],
        },
      ],
    });
    const amended = structuredClone(task.guided!.plan);
    amended.slices[0]!.diagnostics[0]!.maxRuns = 2;
    assert.notEqual(guidedPlanDigest(amended), task.guided!.digest, 'increasing the allowance requires fresh approval');
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
    assert.equal(turns, 2);
    assert.equal(commandsRun, 1);
  },
);
