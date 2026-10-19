// Guided task tests: blocking reviews and review or implementation questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import type { Reply } from '../src/providers/types.js';
import { windows, message, review, services, fixture } from './helpers/guided-tasks.js';

test('blocking review stops delivery and explicit retry uses fresh sessions with preserved files', windows, async t => {
  const f = fixture(t);
  let reviews = 0;
  const config = services();
  config.connector = async (_, options) => ({
    turn: async prompt => {
      assert.match(prompt, /repository/i);
      reviews++;
      options.emit({ type: 'session.connected', data: { providerSessionId: `review-${reviews}`, model: 'fixture' } });
      return {
        status: 'completed',
        reply:
          reviews === 1
            ? {
                ...review,
                findings: [
                  {
                    severity: 'blocking',
                    description: 'Fixture requests a repair review',
                    evidence: 'Concrete offline finding',
                  },
                ],
              }
            : review,
        usage: null,
        error: null,
      };
    },
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'supervised', repairRounds: 0 } }),
    id = task.id;
  tasks.approve(id, 1, task.guided!.digest);
  await tasks.run(id);
  await tasks.authorize(id);
  const failed = await tasks.assess(id, 'passed', 'One direct statement with no duplication');
  assert.equal(failed.status, 'blocked', failed.note);
  assert.equal(failed.stopReason?.code, 'REVIEW_REPAIR_EXHAUSTED');
  assert.equal(failed.note, 'Offline fixture review');
  assert.equal(reviews, 1);
  assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  const previous = f.store.execution(failed.executionId!);
  const next = await tasks.retry(id);
  assert.equal(next.status, 'awaiting_scope', next.note);
  assert.notEqual(next.executionId, failed.executionId);
  assert.notEqual(f.store.execution(next.executionId!).sessionId, previous.sessionId);
  const workspace = f.store.workspace(next.workspaceId!);
  assert.equal(readFileSync(join(workspace.path!, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
  assert.match(next.feedback, /Concrete offline finding/);
  const repaired = await tasks.authorize(id);
  assert.equal(repaired.status, 'awaiting_assessment', repaired.note);
  const done = await tasks.assess(id, 'passed', 'Reviewed the retained implementation and fresh validation again');
  assert.equal(done.status, 'complete', done.note);
  assert.equal(reviews, 2);
  assert.equal(new Workflow(f.store).get(id).approvedVersion, 1);
});

test('supervised review repairs use the workflow allowance and stop again for authorization', windows, async t => {
  const f = fixture(t);
  let reviews = 0;
  const config = services();
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply:
        ++reviews === 1
          ? {
              ...review,
              findings: [{ severity: 'blocking', description: 'Repair this', evidence: 'Concrete offline finding' }],
            }
          : review,
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    id = f.create();
  await tasks.run(id);
  await tasks.authorize(id);
  const repair = await tasks.assess(id, 'passed', 'One direct statement with no duplication');
  assert.equal(repair.status, 'awaiting_scope', repair.note);
  assert.equal(repair.reviewCycle.repairs, 1);
  assert.match(repair.feedback, /Concrete offline finding/);
  assert.ok(f.store.events(id).some(event => event.type === 'guided.review_repair_requested'));
});

test('review questions persist and an explicit answer resumes the same independent session', windows, async t => {
  const f = fixture(t);
  let turns = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    connector: async (_, options) => ({
      turn: async prompt => {
        turns++;
        if (turns === 2) {
          assert.equal(options.providerSessionId, 'question-review');
          assert.match(prompt, /yes, this is the intended output/);
        }
        options.emit({ type: 'session.connected', data: { providerSessionId: 'question-review', model: 'fixture' } });
        return {
          status: 'completed',
          reply:
            turns <= 2
              ? {
                  kind: 'question',
                  text: 'Clarify one point',
                  questions: [
                    {
                      id: 'output',
                      prompt:
                        turns === 1
                          ? 'Is this output intended?'
                          : 'Confirm the output also applies to the final example?',
                      choices: ['yes'],
                    },
                  ],
                  findings: [],
                }
              : review,
          usage: null,
          error: null,
        };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  });
  const id = f.create();
  await tasks.run(id);
  await tasks.authorize(id);
  const questioned = await tasks.assess(id, 'passed', 'Inspected one direct statement');
  assert.equal(questioned.status, 'awaiting_answer', questioned.note);
  assert.equal(questioned.stopReason?.code, 'AGENT_QUESTION');
  assert.equal(guidedTaskView(f.store, id).questions[0]!.id, 'output');
  await assert.rejects(tasks.answer(id, {}), /every pending/);
  await assert.rejects(tasks.run(id), /awaiting_answer/);
  assert.equal(turns, 1);
  const firstView = guidedTaskView(f.store, id),
    staleKey = guidedDecisionKey(firstView.state, firstView.questionKey);
  const secondQuestion = await tasks.answer(id, { output: 'yes, this is the intended output' });
  assert.equal(secondQuestion.status, 'awaiting_answer');
  assert.equal(turns, 2);
  const secondView = guidedTaskView(f.store, id);
  assert.notEqual(guidedDecisionKey(secondView.state, secondView.questionKey), staleKey);
  await assert.rejects(
    new GuidedTasks(f.store, { expectedState: staleKey }).answer(id, { output: 'stale answer' }),
    /changed/,
  );
  assert.equal(turns, 2);
  const done = await tasks.answer(id, { output: 'yes, including the final example' });
  assert.equal(done.status, 'complete', done.note);
  assert.equal(turns, 3);
  assert.equal(done.reviewId, questioned.reviewId);
});

test(
  'implementation questions require explicit answers and a fresh scope authorization before another turn',
  windows,
  async t => {
    const f = fixture(t);
    let calls = 0;
    const question: Reply = {
      kind: 'question',
      text: 'Confirm greeting',
      questions: [{ id: 'wording', prompt: 'Use hello world?', choices: ['yes'] }],
      findings: [],
    };
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      implementationRunner: options => {
        calls++;
        const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string };
        if (calls === 2) assert.match(request.prompt, /yes, hello world/);
        return services(
          calls === 1 ? "console.log('partial');\n" : "console.log('hello world');\n",
          calls === 1 ? question : message,
        ).implementationRunner!(options);
      },
    });
    const id = f.create();
    await tasks.run(id);
    const questioned = await tasks.authorize(id);
    assert.equal(questioned.status, 'awaiting_answer', questioned.note);
    assert.equal(questioned.stopReason?.code, 'AGENT_QUESTION');
    assert.equal(calls, 1);
    const answered = await tasks.answer(id, { wording: 'yes, hello world' });
    assert.equal(answered.status, 'awaiting_scope', answered.note);
    assert.equal(calls, 1);
    assert.notEqual(answered.policy!.artifact, questioned.policy!.artifact);
    const checkpoint = await tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(calls, 2);
    const done = await tasks.assess(id, 'passed', 'Inspected the final direct greeting statement after answering');
    assert.equal(done.status, 'complete', done.note);
  },
);
