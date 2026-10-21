// Native diagnostics do not replace the controller's final verification of the submitted candidate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { execFileSync } from 'node:child_process';
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
      const validation = () =>
        execFileSync(process.execPath, ['greeting.js'], { cwd: options.cwd, encoding: 'utf8', windowsHide: true });
      writeFileSync(join(options.cwd, 'greeting.js'), "// FORMAT\nconsole.log('wrong');\n");
      assert.notEqual(validation(), 'hello world\n');
      writeFileSync(join(options.cwd, 'greeting.js'), "// FORMAT\nconsole.log('hello world');\n");
      writeFileSync(
        join(options.cwd, 'greeting.js'),
        readFileSync(join(options.cwd, 'greeting.js'), 'utf8').replace('// FORMAT\n', ''),
      );
      assert.equal(readFileSync(join(options.cwd, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
      assert.equal(validation(), 'hello world\n');
      const run = f.store.implementation(id),
        execution = f.store.execution(run.executionId);
      assert.equal(f.store.lease(execution.workspaceId)?.runId, id);
      assert.equal(
        f.store.checks(execution.id).length,
        0,
        'native diagnostics do not create controller verification evidence',
      );
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
