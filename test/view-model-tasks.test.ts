// View model scenarios over real guided task journals: presentation status, attention items, actions with
// their decision keys and workflow strip states for a supervised file approval and question, a failed
// check and a timed-out check. Delivery and stalls are in view-model-delivery.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { availableQualityPasses } from '../src/domain/quality-passes.js';
import { healthView } from '../src/health/health.js';
import type { Reply } from '../src/providers/types.js';
import type { ViewContext } from '../src/server/view-model/context.js';
import { taskDetail, taskFacts } from '../src/server/view-model/task-detail.js';
import { overview } from '../src/server/view-model/overview.js';
import type { TaskDetailV1 } from '../src/server/api-types.js';
import { windows, services, fixture, review, lens, slowValidation } from './helpers/guided-tasks.js';

const idlePool = { active: 0, limit: 2, owners: [] };

function context(stall: ViewContext['stall'] = () => null): ViewContext {
  return { job: () => null, stall, qualityPasses: availableQualityPasses(), pool: idlePool };
}

function detail(f: ReturnType<typeof fixture>, id: string, view = context()): TaskDetailV1 {
  return taskDetail(taskFacts(f.store, id), view, f.store.revision());
}

function home(f: ReturnType<typeof fixture>, id: string, view = context()) {
  return overview(
    {
      tasks: [taskFacts(f.store, id)],
      unreadable: [],
      kickoffs: [],
      health: healthView(f.store),
      application: { version: '0.0.0', channel: 'development', build: null },
      journal: f.store.path,
      qualityPasses: availableQualityPasses(),
    },
    view,
    f.store.revision(),
  );
}

const stage = (view: TaskDetailV1, id: string) => view.workflow.find(item => item.id === id);
const action = (view: TaskDetailV1, id: string) => view.decisions.find(item => item.id === id);

test(
  'a supervised task waits for file approval, then for an answer, with forms bound to the shown state',
  windows,
  async t => {
    const f = fixture(t);
    const question: Reply = {
      kind: 'question',
      text: 'Confirm greeting',
      questions: [{ id: 'wording', prompt: 'Use hello world?', choices: ['yes'] }],
      findings: [],
    };
    const tasks = new GuidedTasks(f.store, services("console.log('partial');\n", question));
    const id = f.create();
    await tasks.run(id);

    const scope = detail(f, id);
    assert.equal(scope.header.status, 'awaiting_human');
    assert.equal(scope.header.statusLabel, 'Workspace confirmation needed');
    assert.deepEqual(scope.header.nextStep, {
      kind: 'human',
      label: 'Inspect the workspace and confirm native execution.',
      actionIds: ['authorize', 'refresh-checkpoint'],
    });
    const authorize = action(scope, 'authorize')!;
    assert.equal(authorize.enabled, true);
    assert.equal(authorize.expected, guidedDecisionKey(f.store.get(id).guided!));
    assert.deepEqual(authorize.request, {
      method: 'POST',
      path: `/api/tasks/${id}/authorize`,
      body: { expected: authorize.expected },
    });
    assert.equal(action(scope, 'refresh-checkpoint')!.request.path, `/api/tasks/${id}/retry`);
    assert.deepEqual(
      scope.details.scope?.files.map(file => [file.path, file.action, file.content]),
      [],
    );
    assert.deepEqual(
      scope.details.scope?.instructions.map(item => item.path),
      ['AGENTS.md'],
    );
    assert.equal(stage(scope, 'plan')!.state, 'passed');
    assert.equal(stage(scope, 'implement')!.state, 'active');
    assert.equal(stage(scope, 'implement')!.detail, 'Waiting for you');
    assert.deepEqual(
      home(f, id).attention.map(item => [item.kind, item.taskId, item.actions.map(entry => entry.id)]),
      [['scope_authorization', id, ['authorize', 'refresh-checkpoint']]],
    );

    await tasks.authorize(id);
    const asked = detail(f, id);
    assert.equal(asked.header.statusLabel, 'Your answer is needed');
    assert.equal(asked.header.stopReason?.code, 'AGENT_QUESTION');
    const answer = action(asked, 'answer')!;
    assert.equal(answer.form?.kind, 'answers');
    assert.deepEqual(
      answer.form?.fields.map(field => [field.label, field.target, field.suggestions, field.required]),
      [['Use hello world?', '/answers/wording', ['yes'], true]],
    );
    const view = f.store.get(id).guided!;
    assert.notEqual(answer.expected, guidedDecisionKey(view), 'answers also bind the exact question round');
    assert.equal(home(f, id).attention[0]?.kind, 'question');
    assert.equal(asked.details.scope, null, 'file contents are only sent while authorization is pending');
    assert.equal(asked.usage.headline.tokens, null, 'unmeasured usage is unknown, never 0');
  },
);

test('an exhausted check repair is a failed check with a primary retry and no rerun', windows, async t => {
  const f = fixture(t);
  const tasks = new GuidedTasks(f.store, services("console.log('wrong');\n"));
  const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic', repairRounds: 0 } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.stopReason?.code, 'CHECK_REPAIR_EXHAUSTED', stopped.note);

  const view = detail(f, task.id);
  assert.equal(view.header.status, 'failed');
  assert.equal(view.header.statusLabel, 'Repair allowance used up');
  assert.deepEqual(
    view.decisions.map(item => [item.id, item.kind, item.enabled]),
    [
      ['retry', 'primary', true],
      ['revise', 'secondary', true],
      ['report', 'secondary', true],
      ['reset', 'secondary', true],
      ['delete', 'danger', true],
    ],
  );
  assert.equal(stage(view, 'implement')!.state, 'passed');
  assert.equal(stage(view, 'implement')!.evidence, 'agent-reported');
  assert.equal(stage(view, 'validate')!.state, 'failed');
  assert.equal(stage(view, 'review')!.state, 'pending');
  assert.deepEqual(
    stage(view, 'review')!.items.map(item => [item.id, item.state]),
    [['lens:simplification', 'pending']],
  );
  const check = view.results.checks.find(item => item.purposeLabel === 'Validation')!;
  assert.equal(check.state, 'failed');
  assert.equal(check.evidence, 'controller-verified');
  assert.match(check.issue ?? '', /AssertionError|hello world|wrong/);
  assert.match(check.outputPath, new RegExp(`/api/tasks/${task.id}/check-output\\?checkId=`));
  assert.ok(view.results.unresolved.some(item => /Validation .*failed/.test(item)));
  const item = home(f, task.id).attention[0]!;
  assert.equal(item.kind, 'failed_check');
  assert.equal(item.stopReason, 'CHECK_REPAIR_EXHAUSTED');
  assert.deepEqual(
    item.actions.map(entry => entry.id),
    ['retry'],
  );
  assert.doesNotMatch(JSON.stringify(view), /task-retry|task-show/, 'notes use dashboard language');
});

test('a timed-out check offers rerun first and draws validation as unknown, not failed', windows, async t => {
  const f = fixture(t);
  const config = services();
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed' as const,
      reply: { ...review, lenses: [lens('pass', 'One direct output statement.')] },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [{ ...f.plan.slices[0]!, validation: slowValidation(null) }],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.stopReason?.code, 'CHECK_TIMEOUT', stopped.note);

  const view = detail(f, task.id);
  assert.equal(view.header.status, 'blocked');
  assert.equal(view.header.statusLabel, 'Check timed out');
  assert.deepEqual(view.header.nextStep, {
    kind: 'human',
    label: 'Check timed out: choose how to continue.',
    actionIds: ['rerun-checks', 'retry'],
  });
  assert.deepEqual(
    view.decisions.slice(0, 2).map(item => [item.id, item.kind]),
    [
      ['rerun-checks', 'primary'],
      ['retry', 'secondary'],
    ],
  );
  assert.equal(action(view, 'rerun-checks')!.request.body?.['expected'], action(view, 'retry')!.expected);
  assert.equal(stage(view, 'validate')!.state, 'unknown');
  assert.equal(home(f, task.id).attention[0]?.kind, 'blocked');
});
