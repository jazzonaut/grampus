// Exercises in-turn diagnostics on real repositories and journals while the implementation lease stays held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'implementer checks and formats its edits in one turn, with final checks rejecting a later regression',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let turns = 0;
    config.implementationRunner = async options => {
      turns++;
      const id = options.receipt!.checkId;
      const commands = new ImplementationCommands(f.store, id);
      writeFileSync(join(options.cwd, 'greeting.js'), "// FORMAT\nconsole.log('wrong');\n");
      await assert.rejects(commands.run('arbitrary command'), /Unknown approved/);
      const failed = (await commands.run('validation')) as { phase: string };
      assert.equal(failed.phase, 'failed');
      writeFileSync(join(options.cwd, 'greeting.js'), "// FORMAT\nconsole.log('hello world');\n");
      await commands.finish();
      assert.equal(readFileSync(join(options.cwd, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
      assert.equal(((await commands.run('validation')) as { phase: string }).phase, 'passed');
      const run = f.store.implementation(id),
        execution = f.store.execution(run.executionId);
      assert.equal(f.store.lease(execution.workspaceId)?.runId, id);
      assert.ok(f.store.checks(execution.id).every(check => check.implementationId === id));
      return inlineImplementation(options, "console.log('regressed after diagnostics');\n");
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      quality: { passes: [] },
      workflowPolicy: { mode: 'automatic', repairRounds: 0 },
      slices: [
        {
          ...f.plan.slices[0],
          formatting: {
            name: 'Format authorised source',
            file: 'node',
            args: [
              '-e',
              "const f=require('node:fs'),p='greeting.js';f.writeFileSync(p,f.readFileSync(p,'utf8').replace('// FORMAT\\n',''))",
            ],
            timeoutMs: 15000,
          },
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(result.stopReason?.code, 'CHECK_REPAIR_EXHAUSTED', result.note);
    assert.equal(turns, 1);
    assert.equal(result.readinessCycle.used, 0);
    assert.equal(f.store.lease(result.workspaceId!), null);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
    const timings = f.store.checkTimings(f.repo, task.guided!.plan.workspace.base);
    assert.ok(timings.some(timing => timing.name === 'Validation' && timing.milliseconds >= 0));
    assert.deepEqual(f.store.checkTimings(f.repo, 'another-base'), []);
  },
);
