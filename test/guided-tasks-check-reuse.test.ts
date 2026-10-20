// Real supervised diagnostics can satisfy a final gate only through a fresh, input-bound adoption record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('a completed diagnostic is adopted on unchanged inputs while acceptance remains independent', windows, async t => {
  const f = fixture(t),
    config = services();
  config.implementationRunner = async options => {
    writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
    const commands = new ImplementationCommands(f.store, options.receipt!.checkId);
    await commands.run('validation');
    return inlineImplementation(options, "console.log('hello world');\n");
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    quality: { passes: [] },
    workflowPolicy: { mode: 'automatic' },
    slices: [{ ...f.plan.slices[0], validation: { ...f.plan.slices[0]!.validation, reuse: { inputs: [] } } }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.status, 'complete', state.note);
  const checks = f.store.checks(state.executionId!);
  const adopted = checks.find(check => check.reusedFrom);
  assert.ok(
    adopted,
    JSON.stringify(checks.map(check => ({ phase: check.phase, fingerprint: check.inputFingerprint }))),
  );
  assert.equal(adopted.dispatch, 'not_requested');
  assert.ok(f.store.check(adopted.reusedFrom!).receipt);
  assert.ok(checks.some(check => check.purpose === 'verification' && check.dispatch === 'requested'));
});
