// Exercises the complete finishing loop under a real implementation lease and journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'finishing groups approved independent diagnostics while the implementation still owns the workspace',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    config.implementationRunner = async options => {
      const id = options.receipt!.checkId;
      const executionId = f.store.implementation(id).executionId;
      const snapshotCount = () =>
        f.store
          .executionEvents(executionId, ['execution.phase_measured'])
          .filter(event => (event.data as { phase: string }).phase === 'snapshot').length;
      const initialSnapshots = snapshotCount();
      let active = 0,
        peak = 0,
        entered = 0;
      let release!: () => void;
      const bothStarted = new Promise<void>(resolve => {
        release = resolve;
      });
      const commands = new ImplementationCommands(f.store, id, async () => {
        active++;
        entered++;
        peak = Math.max(peak, active);
        if (entered === 2) release();
        if (entered <= 2)
          await Promise.race([
            bothStarted,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Concurrent check did not start')), 5000)),
          ]);
        active--;
        return {
          reason: 'exited',
          exitCode: 0,
          exitConfirmed: true,
          stdout: 'verbose successful output',
          stderr: '',
          outputTruncated: false,
        };
      });
      writeFileSync(join(options.cwd, 'greeting.js'), "console.log('hello world');\n");
      const result = (await commands.run('finish')) as { phase: string; checks: { stdout?: string }[] };
      assert.equal(result.phase, 'passed');
      assert.equal(result.checks.length, 3);
      assert.equal(((await commands.run('finish')) as { phase: string }).phase, 'passed');
      assert.equal(
        entered,
        3,
        'an unchanged finishing cycle should reuse explicitly repeatable readiness and validation results',
      );
      assert.equal(peak, 2);
      assert.ok(result.checks.every(check => check.stdout === undefined));
      assert.equal(commands.running, false);
      const execution = f.store.execution(f.store.implementation(id).executionId);
      assert.ok(
        snapshotCount() - initialSnapshots <= 4,
        `exclusive finishing cycles took ${snapshotCount() - initialSnapshots} snapshots`,
      );
      assert.equal(f.store.lease(execution.workspaceId)?.runId, id);
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
          readinessConcurrency: 2,
          validation: { ...f.plan.slices[0]!.validation, reuse: { inputs: [] } },
          readiness: [
            { kind: 'lint', name: 'Lint', file: 'node', args: ['-e', ''], timeoutMs: 15000, reuse: { inputs: [] } },
            { kind: 'types', name: 'Types', file: 'node', args: ['-e', ''], timeoutMs: 15000, reuse: { inputs: [] } },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const result = await tasks.run(task.id);
    assert.equal(result.stage, 'readiness', result.note);
    assert.equal(f.store.implementations(result.executionId!)[0]?.phase, 'completed');
  },
);
