// Guided task tests: automatic repair of failed checks and failed quality lens assessments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { Sessions } from '../src/execution/sessions.js';
import { windows, review, services, fixture, lens } from './helpers/guided-tasks.js';

test('automatic work repairs a failed check with complete evidence and resumes its implementer', windows, async t => {
  const f = fixture(t);
  let implementations = 0;
  const config = services();
  config.implementationRunner = options => {
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8'));
    const run = f.store.implementation(request.id);
    const execution = f.store.execution(run.executionId),
      sessions = new Sessions(f.store);
    const session = sessions.get(execution.sessionId);
    if (implementations++) {
      assert.equal(session.providerSessionId, 'offline-implementation');
      assert.match(request.prompt, /Actual assertion at the end/);
      assert.match(request.prompt, /grampus_read_check/);
      assert.ok(request.prompt.length < 20000);
    }
    sessions.event(session.id, run.id, {
      type: 'session.connected',
      data: { providerSessionId: 'offline-implementation', model: 'fixture' },
    });
    return services(implementations === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n")
      .implementationRunner!(options);
  };
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: {
        ...review,
        lenses: [lens('pass', 'One output statement; no duplication or unnecessary abstractions.')],
      },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    slice = f.plan.slices[0]!;
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      {
        ...slice,
        validation: {
          file: 'node',
          args: [
            '-e',
            "if(require('node:fs').readFileSync('greeting.js','utf8').includes('wrong')){console.error('noise '.repeat(4000));console.error('\\u001b[31mAssertionError: Actual assertion at the end\\u001b[0m');process.exitCode=1}",
          ],
          timeoutMs: 15000,
        },
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(done.stopReason, null);
  assert.equal(implementations, 2);
  const events = f.store.events(task.id);
  assert.equal(events.filter(event => event.type === 'guided.validation_repair_requested').length, 1);
  assert.ok(
    !events.some(
      event =>
        (event.data as any)?.status === 'awaiting_scope' || (event.data as any)?.status === 'awaiting_assessment',
    ),
  );
  assert.equal(
    f.store
      .get(task.id)
      .evidence.find((e: any) => e.kind === 'quality' && e.pass === 'simplification' && e.outcome === 'passed')!.source,
    'agent',
  );
});

test('automatic validation stops spending tokens when a repair leaves content unchanged', windows, async t => {
  const f = fixture(t);
  let implementations = 0;
  const config = services("console.log('wrong');\n");
  const runner = config.implementationRunner!;
  config.implementationRunner = options => {
    implementations++;
    return runner(options);
  };
  const tasks = new GuidedTasks(f.store, config),
    task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic', repairRounds: 3 } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.note, /no.*progress|unchanged/i);
  assert.equal(stopped.stopReason?.code, 'CHECK_NO_PROGRESS');
  assert.equal(implementations, 2);
  assert.equal(f.store.deliveries(stopped.executionId!).length, 0);
});

test('an independent failed simplification lens triggers repair rather than a manual form', windows, async t => {
  const f = fixture(t);
  let edits = 0,
    reviews = 0;
  const config = services();
  config.implementationRunner = options =>
    services(++edits === 1 ? "// needless explanation\nconsole.log('hello world');\n" : "console.log('hello world');\n")
      .implementationRunner!(options);
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: {
        ...review,
        lenses: [
          ++reviews === 1
            ? lens('fail', 'Remove the comment that repeats the output statement.')
            : lens('pass', 'The direct output statement now stands on its own.'),
        ],
      },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(done.stopReason, null);
  assert.equal(edits, 2);
  assert.equal(reviews, 2);
});
