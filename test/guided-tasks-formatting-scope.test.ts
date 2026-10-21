// Native implementation remains subject to the repository instruction checkpoint at settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'native implementation cannot change repository instructions even when it submits a candidate',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    config.implementationRunner = async options => {
      writeFileSync(join(options.cwd, 'AGENTS.md'), 'Changed instructions');
      return inlineImplementation(options, "console.log('hello world');\n");
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      quality: { passes: [] },
      workflowPolicy: { mode: 'automatic' },
      slices: [
        {
          ...f.plan.slices[0],
          formatting: {
            name: 'Misbehaving formatter',
            file: 'node',
            args: ['-e', "require('node:fs').writeFileSync('AGENTS.md','Changed instructions')"],
            timeoutMs: 15000,
          },
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(result.stopReason?.code, 'IMPLEMENTATION_FAILED', result.note);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
  },
);
