// Exhaustion must request an actual controller permission change before another paid turn or gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';
import { guidedDecisionDigest, guidedQuestionKey } from '../src/orchestration/guided/keys.js';
import { DiagnosticBudget } from '../src/execution/diagnostic-budget.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test(
  'diagnostic exhaustion stops before review and acceptance instead of asking an ineffective question',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    let turns = 0,
      dispatched = 0;
    config.implementationRunner = async options => {
      turns++;
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId, async () => {
        dispatched++;
        return {
          reason: 'exited',
          exitCode: 1,
          exitConfirmed: true,
          stdout: 'failed case',
          stderr: '',
          outputTruncated: false,
        };
      });
      if (turns === 2) {
        assert.deepEqual(new DiagnosticBudget(f.store, options.receipt!.checkId).usage('diagnostic:Browser', 1), {
          used: 1,
          limit: 3,
          remaining: 2,
        });
        await commands.run('diagnostic:Browser');
        await commands.run('diagnostic:Browser');
        const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
        tasks.pause(execution.taskId);
        return inlineImplementation(options, "console.log('hello world');\n");
      }
      await commands.run('diagnostic:Browser');
      await assert.rejects(commands.run('diagnostic:Browser'), /budget exhausted/);
      const result = await inlineImplementation(options, "console.log('hello world');\n");
      writeFileSync(
        join(options.receipt!.directory, 'result.json'),
        JSON.stringify({
          id: options.receipt!.checkId,
          result: {
            status: 'completed',
            reply: {
              kind: 'question',
              text: 'Need a controller allowance',
              questions: [{ id: 'budget', prompt: 'Permit two focused attempts?', choices: ['Permit'] }],
              findings: [],
            },
            usage: null,
            error: null,
          },
        }),
      );
      return result;
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: [] },
      slices: [
        {
          ...f.plan.slices[0],
          diagnostics: [
            {
              name: 'Browser',
              file: 'node',
              args: ['-e', ''],
              timeoutMs: 15000,
              maxRuns: 1,
              selection: { parameters: [], fileSuffixes: [] },
            },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.stopReason?.code, 'DIAGNOSTIC_ALLOWANCE_REQUIRED', state.note);
    assert.equal(f.store.executions().filter(e => e.role === 'review').length, 0);
    assert.equal(state.stage, 'implementation');
    await assert.rejects(tasks.answer(task.id, { approve: 'yes' }), /No guided questions/);
    await assert.rejects(tasks.approveDiagnosticAllowance(task.id, 'stale'), /Inspect/);
    assert.equal(dispatched, 1);
    const oldKey = guidedDecisionDigest(state, guidedQuestionKey(f.store, state));
    assert.notEqual(guidedQuestionKey(f.store, state), null);
    const session = f.store.session(f.store.execution(state.executionId!).sessionId);
    f.store.transaction(() => {
      session.lastReply!.questions[0]!.prompt = 'Permit two attempts on the updated question?';
      f.store.saveSession(session.id, session);
      f.store.appendSession(session.id, 'test.question_updated', {});
    });
    await assert.rejects(tasks.approveDiagnosticAllowance(task.id, oldKey, undefined, { budget: 'Permit' }), /Inspect/);
    const expected = guidedDecisionDigest(state, guidedQuestionKey(f.store, state));
    await assert.rejects(tasks.approveDiagnosticAllowance(task.id, expected), /approval form/);
    const resumed = await tasks.approveDiagnosticAllowance(task.id, expected, undefined, {
      budget: 'Permit',
    });
    assert.equal(resumed.stopReason?.code, 'USER_PAUSED', resumed.note);
    assert.equal(dispatched, 3);
    assert.equal(resumed.version, 1);
    assert.equal(resumed.digest, task.guided!.digest);
    assert.equal(resumed.plan.slices[0]!.diagnostics[0]!.maxRuns, 1);
    assert.equal(f.store.events(task.id, ['guided.diagnostic_allowance_approved']).length, 1);
    await assert.rejects(tasks.approveDiagnosticAllowance(task.id, guidedDecisionDigest(state)), /Inspect/);
  },
);
