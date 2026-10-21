// A formatter that already passed without changes can be adopted only against its exact input state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows, git } from './helpers/guided-tasks.js';

test(
  'finishing formats before validation and avoids repeating an explicitly reusable final formatter',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    mkdirSync(join(f.repo, 'src'));
    for (let index = 0; index < 64; index++)
      writeFileSync(join(f.repo, 'src', `unchanged-${index}.ts`), 'export const baseline = true;\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'Add unrelated directory content');
    let formatted = 0;
    config.implementationRunner = async options => {
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async command => {
        const format = command.args[1] === 'format';
        if (format) {
          formatted++;
          const path = join(command.cwd, 'greeting.js');
          writeFileSync(path, readFileSync(path, 'utf8').replace('// FORMAT\n', ''));
        }
        if (!format) assert.equal(formatted, 1, 'format precedes validation');
        const passed = format || readFileSync(join(command.cwd, 'greeting.js'), 'utf8').includes('hello world');
        return {
          reason: 'exited',
          exitCode: passed ? 0 : 1,
          exitConfirmed: true,
          stdout: '',
          stderr: passed ? '' : 'Wrong greeting',
          outputTruncated: false,
        };
      });
      writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
      assert.equal(((await commands.run('finish')) as { phase: string }).phase, 'passed');
      await commands.finish();
      assert.equal(formatted, 1);
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
          scope: { files: ['greeting.js'], directories: [{ path: 'src', actions: ['edit'], suffixes: ['.ts'] }] },
          formatting: {
            name: 'Formatter',
            file: 'node',
            args: ['-e', 'format'],
            timeoutMs: 15000,
            reuse: { inputs: [] },
          },
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(f.store.implementations(result.executionId!)[0]?.phase, 'completed', result.note);
  },
);
