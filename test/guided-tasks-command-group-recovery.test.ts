// A grouped diagnostic never turns a sibling's mutation or uncertain exit into artifact evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'group mutation invalidates every child and a later uncertain child retains the parent without replay',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let calls = 0,
      uncertain = false;
    config.implementationRunner = async options => {
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async command => {
        calls++;
        const unknown = uncertain && command.args[1] === 'first';
        if (!uncertain) writeFileSync(join(command.cwd, 'greeting.js'), "console.log('mutated by diagnostic');\n");
        return {
          reason: unknown ? 'supervisor_lost' : 'exited',
          exitCode: unknown ? null : 0,
          exitConfirmed: !unknown,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        };
      });
      const failed = (await commands.run('finish')) as { phase: string; checks: { phase: string; error?: string }[] };
      assert.equal(failed.phase, 'failed');
      assert.ok(
        failed.checks.every(check => check.phase === 'failed' && check.error?.includes('changed repository inputs')),
      );
      assert.equal(commands.running, false);
      writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
      uncertain = true;
      await assert.rejects(commands.run('finish'), /recovery/);
      assert.equal(commands.running, true);
      await assert.rejects(commands.run('validation'), /unsettled/);
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
          readinessConcurrency: 2,
          readiness: [
            { kind: 'lint', file: 'node', args: ['-e', 'first'], timeoutMs: 15000 },
            { kind: 'types', file: 'node', args: ['-e', 'second'], timeoutMs: 15000 },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(result.stopReason?.code, 'OPERATION_NEEDS_RECOVERY', result.note);
    assert.equal(calls, 4);
    assert.ok(f.store.lease(result.workspaceId!));
    assert.ok(f.store.checks(result.executionId!).every(check => check.phase !== 'passed'));
  },
);
