// Guided task tests: edit quality passes run as scoped implementer turns after the first successful
// implementation and before validation, in order and once per slice. Lens assessment by a person is
// in guided-tasks-quality-assessment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { builtInQualityPasses } from '../src/domain/quality-passes.js';
import { runCheckProcess, type CheckProcessOptions } from '../src/process/check-process.js';
import type { ImplementationRun } from '../src/execution/implementations.js';
import type { Execution } from '../src/execution/execution-state.js';
import type { Reply, TurnResult } from '../src/providers/types.js';
import { windows, message, services, fixture } from './helpers/guided-tasks.js';

/** An offline implementer turn that writes `source` (or nothing) to greeting.js and settles as `status`. */
function turn(
  options: CheckProcessOptions,
  source: string | null,
  status: TurnResult['status'] = 'completed',
  reply: Reply = message,
) {
  const result: TurnResult = {
    status,
    reply: status === 'completed' ? reply : null,
    usage: null,
    error: status === 'completed' ? null : 'Offline quality pass failure',
  };
  return runCheckProcess({
    ...options,
    args: [
      '-e',
      `const fs = require('node:fs');
      ${source === null ? '' : `fs.writeFileSync('greeting.js', ${JSON.stringify(source)});`}
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)}, result:${JSON.stringify(result)}}));`,
    ],
  });
}

const prompt = (options: CheckProcessOptions) =>
  (JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string }).prompt;

const question: Reply = {
  kind: 'question',
  text: 'One decision is needed',
  questions: [{ id: 'punctuation', prompt: 'Should the greeting end with a full stop?', choices: [] }],
  findings: [],
};

test(
  'edit passes run in order before validation, once per slice; a repair does not run them again',
  windows,
  async t => {
    const f = fixture(t);
    const prompts: string[] = [];
    const turns: [string | null, Reply][] = [
      ["console.log('wrong');\n", message],
      [null, message], // The refactor pass finds nothing to change.
      ["// Prints the requested greeting.\nconsole.log('wrong');\n", message],
      // The repair after failed validation asks a question, so the test stops before a second validation.
      ["console.log('hello world');\n", question],
    ];
    const config = services();
    config.implementationRunner = options => {
      prompts.push(prompt(options));
      const [source, reply] = turns[prompts.length - 1]!;
      return turn(options, source, 'completed', reply);
    };
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      quality: { passes: ['naming', 'refactor', 'documentation'] },
    });
    assert.deepEqual(
      task.guided!.plan.quality.passes.map(pass => pass.id),
      ['naming', 'refactor', 'documentation'],
    );
    tasks.approve(task.id, 1, task.guided!.digest);
    const waiting = await tasks.run(task.id);
    assert.equal(waiting.status, 'awaiting_answer', waiting.note);
    assert.equal(waiting.stage, 'implementation');
    assert.equal(prompts.length, 4);
    const instructions = (id: string) => builtInQualityPasses.find(pass => pass.id === id)!.instructions;
    assert.ok(prompts[1]!.includes(instructions('refactor')));
    assert.ok(prompts[2]!.includes(instructions('documentation')));
    assert.doesNotMatch(prompts[3]!, /quality pass/);
    assert.match(prompts[3]!, /Earlier attempt evidence/);
    assert.deepEqual(
      waiting.qualityEdits.map(edit => [edit.pass, edit.before === edit.after]),
      [
        ['refactor', true],
        ['documentation', false],
      ],
    );
    // Both passes resumed the first attempt's implementation conversation, and validation ran only after them.
    const first = f.store
      .executions<Execution>()
      .find(execution => execution.taskId === task.id && execution.role === 'implementation')!;
    const runs = f.store.implementations<ImplementationRun>(first.id);
    assert.equal(runs.length, 3);
    assert.equal(new Set(runs.map(run => run.policy.files.join())).size, 1);
    assert.deepEqual(
      f.store
        .executionEvents(first.id)
        .filter(event => event.type === 'quality_pass.completed')
        .map(event => (event.data as { pass: string }).pass),
      ['refactor', 'documentation'],
    );
    const events = f.store.events(task.id).map(event => event.type);
    const settled = events.flatMap((type, index) => (type === 'implementation.settled' ? [index] : []));
    assert.ok(events.indexOf('check.requested') > settled[2]!, 'validation runs after both edit passes');
    assert.equal(f.store.checks(first.id).length, 1);
  },
);

test('a failed edit pass stops before validation with QUALITY_PASS_FAILED', windows, async t => {
  const f = fixture(t);
  let turns = 0;
  const config = services();
  config.implementationRunner = options =>
    ++turns === 1 ? turn(options, "console.log('hello world');\n") : turn(options, null, 'failed');
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: ['refactor'] } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.stage, 'quality_pass');
  assert.equal(stopped.stopReason?.code, 'QUALITY_PASS_FAILED');
  assert.match(stopped.note, /Quality pass refactor failed/);
  assert.equal(f.store.checks(stopped.executionId!).length, 0);
  assert.deepEqual(stopped.qualityEdits, []);
});
