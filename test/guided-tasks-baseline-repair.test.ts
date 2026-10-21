// A regression the change itself caused passes on the starting commit, so the repair is spent as usual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, lens, review, services, windows } from './helpers/guided-tasks.js';

/** An automatic plan whose second acceptance check is a regression suite. */
function regressionPlan(f: ReturnType<typeof fixture>, args: string[]) {
  const slice = f.plan.slices[0]!;
  return {
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      {
        ...slice,
        acceptance: [
          ...slice.acceptance,
          {
            name: 'Full regression',
            file: 'node',
            args,
            expectedStdout: 'regression passed\n',
            timeoutMs: 15000,
            regression: true,
          },
        ],
      },
    ],
  };
}

const baselines = (f: ReturnType<typeof fixture>, id: string) =>
  f.store
    .executions(id)
    .flatMap(execution => f.store.executionEvents(execution.id, ['baseline.completed']))
    .map(event => event.data as { outcome: string; head: string });

test('a regression the change caused passes on the starting commit and is repaired', windows, async t => {
  const f = fixture(t);
  let edits = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    connector: async () => ({
      turn: async () => ({
        status: 'completed' as const,
        reply: { ...review, lenses: [lens('pass', 'Inspected the direct output statement')] },
        usage: null,
        error: null,
      }),
      interrupt: async () => {},
      close: async () => {},
    }),
    implementationRunner: options => {
      edits++;
      // The first attempt breaks the regression suite with a stray marker; the repair removes it.
      return services(edits === 1 ? "console.log('hello world'); // legacy-marker\n" : "console.log('hello world');\n")
        .implementationRunner!(options);
    },
  });
  const check =
    "const s=require('node:fs').readFileSync('greeting.js','utf8');if(s.includes('legacy-marker'))process.exit(1);console.log('regression passed');";
  const task = tasks.create(regressionPlan(f, ['-e', check]));
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(edits, 2);
  assert.equal(done.repairCycle.used, 1);
  assert.deepEqual(
    baselines(f, task.id).map(item => item.outcome),
    ['passed'],
  );
});
