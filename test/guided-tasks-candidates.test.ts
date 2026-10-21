// Exercises candidate submission through real worktrees, checks, review and local delivery.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { parseReply } from '../src/providers/types.js';
import { builtInQualityPasses } from '../src/domain/quality-passes.js';
import { fixture, inlineImplementation, lens, message, review, services, windows } from './helpers/guided-tasks.js';

test('unfinished turns continue in the same execution until a candidate is submitted', windows, async t => {
  const f = fixture(t);
  const config = services();
  let turns = 0;
  config.implementationRunner = async options => {
    turns++;
    const request = JSON.parse(readFileSync(options.args.at(-1)!, 'utf8')) as { prompt: string };
    for (const id of ['refactor', 'documentation'])
      assert.ok(request.prompt.includes(builtInQualityPasses.find(pass => pass.id === id)!.instructions));
    const result = await inlineImplementation(options, "console.log('hello world');\n");
    writeFileSync(
      join(options.receipt!.directory, 'result.json'),
      JSON.stringify({
        id: options.receipt!.checkId,
        result: {
          status: 'completed',
          reply: turns === 1 ? { ...message, kind: 'message' } : parseReply({ ...message, kind: 'candidate' }),
          usage: null,
          error: null,
        },
      }),
    );
    if (turns === 2) tasks.pause(task.id);
    return result;
  };
  config.connector = async () => ({
    turn: async () => {
      assert.equal(turns, 2, 'a progress message must not submit an implementation');
      return {
        status: 'completed',
        reply: { ...review, lenses: [lens('pass', 'Inspected the submitted candidate.')] },
        usage: null,
        error: null,
      };
    },
    interrupt: async () => {},
    close: async () => {},
  });
  f.plan.workflowPolicy.mode = 'automatic';
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, quality: { passes: ['refactor', 'documentation'] } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const state = await tasks.run(task.id);
  assert.equal(state.stopReason?.code, 'USER_PAUSED', state.note);
  assert.equal(state.stage, 'validation');
  assert.equal(turns, 2);
  assert.equal(f.store.executions().filter(item => item.role === 'implementation').length, 1);
  assert.equal(state.repairCycle.used, 0, 'progress is not a failed repair');
});
