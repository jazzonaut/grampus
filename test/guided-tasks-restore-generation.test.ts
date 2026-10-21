// Generated dependency inputs must settle before an explicitly declared prerequisite restore is reconsidered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, git, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('generation and prerequisite restoration settle separately, including after a pause', windows, async t => {
  const f = fixture(t),
    config = services();
  writeFileSync(join(f.repo, '.gitignore'), 'managed/\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Ignore managed prerequisites');
  let restores = 0,
    generated = 0;
  config.implementationRunner = options => inlineImplementation(options, "console.log('intermediate');\n");
  config.preparationRunner = async options => {
    if (options.args[1] === 'restore') {
      restores++;
      mkdirSync(join(options.cwd, 'managed'), { recursive: true });
      writeFileSync(join(options.cwd, 'managed', 'installed'), readFileSync(join(options.cwd, 'greeting.js')));
      if (restores === 2) tasks.pause(task.id);
    } else {
      generated++;
      writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
      tasks.pause(task.id);
    }
    return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    quality: { passes: [] },
    workflowPolicy: { mode: 'automatic', repairRounds: 0 },
    preparation: {
      name: 'Restore prerequisites',
      file: 'node',
      args: ['-e', 'restore'],
      timeoutMs: 15000,
      restore: { inputs: ['greeting.js'], outputs: ['managed'] },
    },
    slices: [
      {
        ...f.plan.slices[0],
        preparation: { name: 'Generate inputs', file: 'node', args: ['-e', 'generate'], timeoutMs: 15000 },
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const afterGeneration = await tasks.run(task.id);
  assert.equal(afterGeneration.stage, 'refresh', afterGeneration.note);
  const afterRestore = await tasks.run(task.id);
  assert.equal(afterRestore.stage, 'validation', afterRestore.note);
  assert.equal(generated, 1);
  assert.equal(restores, 2);
  const cwd = f.store.workspace(afterRestore.workspaceId!).path!;
  assert.equal(readFileSync(join(cwd, 'managed', 'installed'), 'utf8'), readFileSync(join(cwd, 'greeting.js'), 'utf8'));
});
