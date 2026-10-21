// A failed regression check runs on the starting commit before a repair is spent, through the real
// Git export, dependency links and supervised process runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, git, services, windows } from './helpers/guided-tasks.js';

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

test('a regression check that already fails without the change stops without spending a repair', windows, async t => {
  const f = fixture(t);
  // A suite that was already broken before the task, like an unrelated timing-out browser test.
  writeFileSync(join(f.repo, 'regression.js'), "console.error('combat judgement timed out');process.exit(1);\n");
  git(f.repo, 'add', 'regression.js');
  git(f.repo, 'commit', '-m', 'Add an already failing regression suite');
  let edits = 0;
  const config = services();
  const tasks = new GuidedTasks(f.store, {
    ...config,
    implementationRunner: options => {
      edits++;
      return config.implementationRunner!(options);
    },
  });
  const task = tasks.create(regressionPlan(f, ['regression.js']));
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stopReason?.code, 'CHECK_FAILS_WITHOUT_CHANGE');
  assert.match(stopped.note, /Full regression failed/);
  assert.match(stopped.note, /combat judgement timed out/);
  assert.equal(stopped.repairCycle.used, 0, 'no repair was spent');
  assert.equal(edits, 1, 'no further implementation turn ran');
  assert.deepEqual(
    baselines(f, task.id).map(item => item.outcome),
    ['failed'],
  );
});
