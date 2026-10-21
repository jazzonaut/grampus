// Explicit repeatability avoids duplicate diagnostic processes while changed ignored inputs and failures invalidate it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'eligible repeated diagnostics reuse their receipt but changed dependencies and later failures force execution',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['-C', f.repo, 'add', '.gitignore'], { windowsHide: true });
    execFileSync('git', ['-C', f.repo, 'commit', '-m', 'Ignore dependencies'], { windowsHide: true });
    let calls = 0,
      fail = false;
    config.implementationRunner = async options => {
      mkdirSync(join(options.cwd, 'node_modules'));
      const dependency = join(options.cwd, 'node_modules', 'dependency.txt');
      writeFileSync(dependency, 'first');
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async () => {
        calls++;
        return {
          reason: 'exited',
          exitCode: fail ? 1 : 0,
          exitConfirmed: true,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        };
      });
      const first = (await commands.run('diagnostic:Unit')) as { checkId: string; diagnosticBudget: { used: number } };
      const reused = (await commands.run('diagnostic:Unit')) as typeof first;
      assert.equal(reused.checkId, first.checkId);
      assert.equal(reused.diagnosticBudget.used, 1);
      assert.equal(calls, 1);
      writeFileSync(dependency, 'second');
      await commands.run('diagnostic:Unit');
      assert.equal(calls, 2);
      fail = true;
      writeFileSync(dependency, 'third');
      await commands.run('diagnostic:Unit');
      await commands.run('diagnostic:Unit');
      assert.equal(calls, 4, 'a later failure cannot fall back to earlier success');
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
              name: 'Unit',
              file: 'node',
              args: ['-e', ''],
              timeoutMs: 15000,
              maxRuns: 8,
              reuse: { inputs: ['node_modules'] },
              selection: { parameters: [], fileSuffixes: [] },
            },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
  },
);
