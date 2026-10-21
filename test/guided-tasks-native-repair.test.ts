// Native repairs must reach controller verification without receipts from unavailable scoped tools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, git, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('a native browser repair candidate proceeds without a scoped diagnostic receipt', windows, async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'greeting.test.js'), '// Browser regression fixture\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Add browser fixture');
  let turns = 0;
  const config = services();
  config.implementationRunner = async options => {
    turns++;
    assert.ok(turns <= 2, 'a repaired native candidate must not loop for an unavailable diagnostic tool');
    if (turns === 2) tasks.pause(task.id);
    return inlineImplementation(options, turns === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n");
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    quality: { passes: [] },
    workflowPolicy: { mode: 'automatic' },
    slices: [
      {
        ...f.plan.slices[0],
        validation: {
          file: 'node',
          args: [
            '-e',
            `if(!require('node:fs').readFileSync('greeting.js','utf8').includes('hello world')){console.log('1) [chromium] › greeting.test.js:1:1 › greeting renders\\nError: expect(received).toBe(expected)\\n1 failed');process.exit(1)}`,
          ],
        },
        diagnostics: [
          {
            name: 'browser',
            file: 'node',
            args: ['node_modules/@playwright/test/cli.js', 'test'],
            selection: { parameters: [{ name: 'case', flag: '--grep' }], fileSuffixes: ['.test.js'] },
          },
        ],
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
  assert.equal(state.stage, 'validation', 'the repaired candidate must reach controller verification');
  assert.equal(turns, 2);
  assert.equal(state.repairCycle.used, 1);
  assert.equal(f.store.events(task.id, ['guided.focused_repair_required']).length, 0);
});
