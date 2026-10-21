// Real journal, lease and repository observations exercise focused repair without replaying broad suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { focusedRepairOutcome } from '../src/orchestration/guided/focused-repair.js';
import type { SettleContext } from '../src/orchestration/guided/context.js';
import { fixture, git, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'missing or failed focused probes prevent broad gates and a passing probe never supplies acceptance',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    const failure =
      '1) [chromium] › greeting.test.js:1:1 › broken smoke\nError: expect(received).toBeGreaterThan(expected)\n1 failed';
    writeFileSync(join(f.repo, 'greeting.test.js'), '// test fixture\n');
    git(f.repo, 'add', 'greeting.test.js');
    git(f.repo, 'commit', '-m', 'Add diagnostic fixture');
    config.implementationRunner = async options => {
      const id = options.receipt!.checkId,
        execution = f.store.execution(f.store.implementation(id).executionId);
      const calls: string[][] = [];
      const runner = async (command: { args: string[] }) => {
        calls.push(command.args);
        return {
          reason: 'exited',
          exitCode: calls.length <= 2 ? 1 : 0,
          exitConfirmed: true,
          stdout: calls.length <= 2 ? failure : '',
          stderr: '',
          outputTruncated: false,
        };
      };
      const initial = (await new ImplementationCommands(f.store, id, runner).run('diagnostic:browser')) as {
        checkId: string;
      };
      // Retain a real failed check as repair feedback. The focused loop cannot turn it into gate evidence.
      f.store.transaction(() => {
        const task = f.store.get(execution.taskId);
        task.guided!.failedCheckId = initial.checkId;
        f.store.save(task.id, task);
        f.store.append(task.id, task.version, 'test.repair_feedback_selected', { checkId: initial.checkId });
      });
      const context = {
        id: execution.taskId,
        store: f.store,
        state: f.store.get(execution.taskId).guided!,
      } as SettleContext;
      const outcome = (checkId: string) =>
        focusedRepairOutcome(context, { ...f.store.implementation(id), after: f.store.check(checkId).after }, () => {});
      assert.equal(
        outcome(initial.checkId)?.kind,
        'advance',
        'ending a turn without a probe must return to scoped repair',
      );
      const commands = new ImplementationCommands(f.store, id, runner);
      const failed = (await commands.run('finish')) as { phase: string; checks: { checkId: string }[] };
      assert.equal(failed.phase, 'failed');
      assert.equal(calls.length, 2, 'a failed focused probe must prevent readiness and validation');
      assert.equal(outcome(failed.checks[0]!.checkId)?.kind, 'advance');
      assert.ok(calls[1]!.includes('--grep'));
      assert.ok(calls[1]!.includes('greeting.test.js'));
      writeFileSync(join(options.cwd, 'greeting.js'), "// fixed\nconsole.log('hello world');\n");
      const passed = (await commands.run('finish')) as { phase: string; checks: { checkId: string }[] };
      assert.equal(passed.phase, 'passed');
      assert.equal(calls.length, 5, 'focused probe, then readiness and validation');
      assert.equal(outcome(passed.checks.at(-1)!.checkId), null);
      assert.equal(f.store.checks(execution.id).filter(check => check.purpose === 'verification').length, 0);
      tasks.pause(execution.taskId);
      return inlineImplementation(options, "// fixed\nconsole.log('hello world');\n");
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: [] },
      slices: [
        {
          ...f.plan.slices[0],
          readiness: [{ kind: 'types', name: 'Types', file: 'node', args: ['-e', ''], timeoutMs: 15000 }],
          diagnostics: [
            {
              name: 'browser',
              file: 'node',
              args: ['node_modules/@playwright/test/cli.js', 'test'],
              timeoutMs: 15000,
              selection: { parameters: [{ name: 'case', flag: '--grep' }], fileSuffixes: ['.test.js'] },
            },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
    assert.equal(state.stage, 'readiness', 'full readiness, validation, review and acceptance remain due');
    assert.deepEqual(state.plan.slices[0]!.acceptance, task.guided!.plan.slices[0]!.acceptance);
  },
);
