// View model rules without running a task: the status vocabulary and stop descriptions, note language,
// usage nulls, the action rules for live, uncertain and rerunnable states, a draft task awaiting
// approval, and a planning conversation from question to proposal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { StopReasonCode } from '../src/orchestration/guided/stop-reasons.js';
import { availableQualityPasses } from '../src/domain/quality-passes.js';
import { healthView } from '../src/health/health.js';
import type { Connector, Reply, TurnResult } from '../src/providers/types.js';
import type { TaskUsage } from '../src/reporting/task-usage.js';
import { poolFullReason, type ViewContext } from '../src/server/view-model/context.js';
import { humanNote, stopPresentation, taskPresentation } from '../src/server/view-model/status.js';
import { usageView } from '../src/server/view-model/usage.js';
import { taskActions, type TaskActionFacts } from '../src/server/view-model/actions.js';
import { taskActionFacts, taskDetail, taskFacts } from '../src/server/view-model/task-detail.js';
import { kickoffDetail } from '../src/server/view-model/kickoff-detail.js';
import { overview } from '../src/server/view-model/overview.js';
import { fixture } from './helpers/guided-tasks.js';

const idlePool = { active: 0, limit: 2, owners: [] };
const view: ViewContext = {
  job: () => null,
  stall: () => null,
  qualityPasses: availableQualityPasses(),
  pool: idlePool,
};

test('every stop reason code has a label, a one-sentence reason and an attention kind', () => {
  for (const code of Object.values(StopReasonCode)) {
    const stop = stopPresentation[code];
    assert.ok(stop.label && !stop.label.endsWith('.'), code);
    assert.match(stop.why, /^[A-Z].*\.$/, code);
    assert.doesNotMatch(`${stop.label} ${stop.why}`, /\u2014/, 'no em dashes in UI text');
  }
  assert.equal(stopPresentation.CHECK_TIMEOUT.status, 'blocked');
  assert.equal(stopPresentation.CHECK_REPAIR_EXHAUSTED.status, 'failed');
  assert.equal(stopPresentation.AGENT_QUESTION.status, 'awaiting_human');
  assert.equal(stopPresentation.SETTLEMENT_UNCONFIRMED.kind, 'recovery');
});

test('notes are rewritten into dashboard language once, on the server', () => {
  assert.equal(
    humanNote('\u001b[31mUse task-retry after staging, or task-rerun-checks; see task-show.\u001b[0m\u0007'),
    'Use a repair attempt after staging, or Rerun checks; see the task details.',
  );
  assert.equal(humanNote('task-authorize then task-run'), 'the workspace confirmation button then Continue task');
});

test('usage keeps unknown values null and marks a total over unknown parts as partial', () => {
  const counters = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostUsd: null,
  };
  const usage: TaskUsage = {
    workflow: null,
    providers: [
      {
        provider: 'codex',
        sessions: 2,
        observedSessions: 1,
        activeSessions: 0,
        updatedAt: null,
        ...counters,
        inputTokens: 100,
        outputTokens: 20,
        incomplete: ['inputTokens'],
        billedCostUsd: null,
      },
      {
        provider: 'claude',
        sessions: 1,
        observedSessions: 0,
        activeSessions: 0,
        updatedAt: null,
        ...counters,
        incomplete: [],
        billedCostUsd: null,
      },
    ],
    stages: [],
    turns: 3,
    failedTurns: 0,
    interruptedTurns: 0,
    unsettledTurns: 0,
    repairAttempts: 1,
    interventions: {
      total: 2,
      answers: 1,
      authorizations: 1,
      assessments: 0,
      retries: 0,
      rerunChecks: 0,
      recoveries: 0,
      revisions: 0,
      stops: 0,
      approvals: 0,
      guidance: 0,
    },
  };
  const result = usageView(usage);
  assert.deepEqual(result.headline, {
    tokens: 120,
    cachedTokens: null,
    estimatedCostUsd: null,
    completeness: 'partial',
    turns: 3,
    interventions: 2,
  });
  assert.equal(result.providers[0]?.completeness, 'partial');
  assert.equal(result.providers[1]?.completeness, 'none');
  assert.equal(result.providers[1]?.inputTokens, null);
  assert.equal(result.providers[0]?.label, 'Codex');
  assert.equal(usageView({ ...usage, providers: [] }).headline.tokens, null);
});

test('the usage headline counts cache tokens once per provider and says how many were cache reads', () => {
  const row = {
    sessions: 1,
    observedSessions: 1,
    activeSessions: 0,
    updatedAt: null,
    estimatedCostUsd: null,
    billedCostUsd: null,
    incomplete: [],
  };
  const usage: TaskUsage = {
    workflow: null,
    providers: [
      // Codex input already includes its cache reads.
      {
        ...row,
        provider: 'codex',
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 0,
      },
      // Claude reports cache reads and writes beside its uncached input.
      {
        ...row,
        provider: 'claude',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 300,
        cacheWriteInputTokens: 40,
      },
    ],
    stages: [],
    turns: 2,
    failedTurns: 0,
    interruptedTurns: 0,
    unsettledTurns: 0,
    repairAttempts: 0,
    interventions: {
      total: 0,
      answers: 0,
      authorizations: 0,
      assessments: 0,
      retries: 0,
      rerunChecks: 0,
      recoveries: 0,
      revisions: 0,
      stops: 0,
      approvals: 0,
      guidance: 0,
    },
  };
  const { headline } = usageView(usage);
  assert.equal(headline.tokens, 1050 + 355);
  assert.equal(headline.cachedTokens, 1100);
  assert.equal(headline.completeness, 'complete');
});

test('a draft waits for approval of its exact version and digest', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const facts = taskFacts(f.store, task.id);
  const detail = taskDetail(facts, view, f.store.revision());
  assert.equal(detail.apiVersion, 1);
  assert.equal(detail.header.status, 'awaiting_human');
  assert.equal(detail.header.statusLabel, 'Plan ready for approval');
  assert.deepEqual(detail.header.nextStep, {
    kind: 'human',
    label: 'Review the plan and approve it.',
    actionIds: ['approve'],
  });
  const approve = detail.decisions[0]!;
  assert.equal(approve.id, 'approve');
  assert.equal(approve.label, 'Approve this plan', 'the fixture plan is supervised');
  assert.deepEqual(approve.request.body, {
    expected: guidedDecisionKey(task.guided!),
    version: 1,
    digest: task.guided!.digest,
  });
  assert.equal(detail.workflow[0]?.state, 'active');
  assert.ok(detail.workflow.slice(1).every(stage => stage.state === 'pending'));
  assert.deepEqual(
    detail.details.plan.qualityPasses.map(pass => pass.id),
    ['simplification'],
  );
  assert.match(detail.details.plan.reviewSummary, /Review repairs use the shared slice allowance/);
  const revise = detail.decisions.find(item => item.id === 'revise')!;
  assert.deepEqual(
    revise.form?.fields.map(field => field.target),
    [
      '/plan',
      '/plan/brief/title',
      '/plan/brief/outcome',
      '/plan/brief/plan',
      '/plan/workflowPolicy/mode',
      '/plan/workflowPolicy/readinessRounds',
      '/plan/workflowPolicy/repairRounds',
      '/plan/workflowPolicy/maxTaskTurns',
      '/plan/workflowPolicy/maxTaskTokens',
      '/plan/workflowPolicy/maxSessionTurns',
      '/plan/workflowPolicy/maxContextTokens',
      '/plan/reviewPolicy/arbitrator',
      '/plan/quality/passes',
    ],
  );
  const home = overview(
    {
      tasks: [facts],
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
  assert.equal(home.health.overall, 'unknown');
  assert.equal(home.health.label, 'Integrations not checked yet');
  assert.deepEqual(home.pool, { running: 0, limit: 2, owners: [] });
  assert.deepEqual(
    home.attention.map(item => [item.kind, item.title, item.stopReason, item.actions.map(entry => entry.id)]),
    [['approval', 'Guided greeting', 'APPROVAL_REQUIRED', ['approve']]],
  );
  assert.equal(home.tasks[0]?.stageLabel, 'Plan');
  assert.equal(home.tasks[0]?.repository.name, 'repo');
});

test('action rules: live work offers stop, uncertain work offers recovery and rerun needs an eligible stop', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const base = taskActionFacts(taskFacts(f.store, task.id), view);
  const facts = (change: Partial<TaskActionFacts>): TaskActionFacts => ({ ...base, ...change });
  const allowance = taskActions(
    facts({
      status: 'blocked',
      stopCode: 'DIAGNOSTIC_ALLOWANCE_REQUIRED',
      diagnosticAllowance: { family: 'diagnostic:browser', from: 3, to: 5 },
      questions: [{ id: 'budget', prompt: 'Permit two attempts?', choices: ['Permit'] }],
    }),
  )[0]!;
  assert.equal(allowance.id, 'diagnostic-allowance');
  assert.match(allowance.description, /from 3 to 5/);
  assert.equal(allowance.request.path, `/api/tasks/${base.taskId}/diagnostic-allowance`);
  assert.equal(allowance.form?.fields[0]?.target, '/answers/budget');
  const ids = (value: TaskActionFacts) =>
    taskActions(value).map(item => `${item.id}${item.enabled ? '' : '(disabled)'}`);

  const working = facts({ status: 'running', owner: true, jobRunning: true });
  assert.equal(taskPresentation(working).status, 'working');
  assert.deepEqual(ids(working), [
    'stop',
    'pause',
    'revise(disabled)',
    'report',
    'reset(disabled)',
    'delete(disabled)',
  ]);
  const stopping = facts({ status: 'running', owner: true, jobRunning: true, stopRequested: true });
  assert.equal(taskPresentation(stopping).status, 'stopping');
  assert.equal(
    taskActions(stopping)[0]?.disabledReason,
    'A stop was already requested; waiting for the current operation to settle.',
  );

  const uncertain = facts({ status: 'blocked', pending: true });
  assert.equal(taskPresentation(uncertain).attention, 'recovery');
  assert.deepEqual(ids(uncertain).slice(0, 1), ['recover']);
  const recovery = facts({ status: 'recovery_required', owner: true, pending: true });
  assert.ok(ids(recovery).includes('discard'));
  assert.equal(ids({ ...recovery, jobRunning: true }).includes('discard'), false);
  const orphaned = facts({ status: 'ready', stage: 'workspace', owner: true, releasable: true });
  assert.deepEqual(ids(orphaned).slice(0, 3), ['recover', 'release-workspace', 'stop']);

  const timeout = facts({ status: 'blocked', stage: 'validation', stopCode: 'CHECK_TIMEOUT', rerunProblem: null });
  assert.deepEqual(ids(timeout).slice(0, 2), ['rerun-checks', 'retry']);
  const limit = facts({
    status: 'blocked',
    stage: 'validation',
    stopCode: 'CHECK_OUTPUT_LIMIT',
    rerunProblem: 'not eligible',
  });
  assert.deepEqual(ids(limit).slice(0, 1), ['retry']);
  assert.equal(taskPresentation(limit).attention, 'resource_limit');
  const preparation = facts({ status: 'blocked', stage: 'preparation', stopCode: 'PREPARATION_FAILED' });
  assert.deepEqual(ids(preparation).slice(0, 1), ['retry-preparation']);

  const stale = facts({ stale: true });
  assert.equal(taskPresentation(stale).status, 'unknown');
  assert.deepEqual(ids(stale), ['reset', 'delete']);
  const scope = facts({ status: 'awaiting_scope', scopeError: 'greeting.js exceeds the scope limit' });
  assert.match(taskActions(scope)[0]?.disabledReason ?? '', /greeting\.js exceeds/);
  assert.equal(taskActions(facts({ status: 'draft', automatic: true }))[0]?.label, 'Approve and start');
});

test('a full runner pool disables actions that start work, but not approval, recovery or revision', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const full = { active: 2, limit: 2, owners: ['first', 'second'] };
  const reason = '2 of 2 tasks are already running. Wait for one to finish, then try again.';
  assert.equal(poolFullReason(full, false), reason);
  assert.equal(poolFullReason(full, true), null, 'a task that owns a runner needs no new slot');
  assert.equal(poolFullReason({ ...full, active: 1 }, false), null);
  const base = taskActionFacts(taskFacts(f.store, task.id), { ...view, pool: full });
  assert.equal(base.poolFull, reason);
  const facts = (change: Partial<TaskActionFacts>): TaskActionFacts => ({ ...base, ...change });
  const disabled = (value: TaskActionFacts) =>
    Object.fromEntries(taskActions(value).map(item => [item.id, item.disabledReason]));

  assert.equal(
    disabled(facts({ status: 'draft' }))['approve'],
    null,
    'approval stands; the server reports started: false',
  );
  assert.equal(disabled(facts({ status: 'ready' }))['run'], reason);
  assert.equal(disabled(facts({ status: 'awaiting_scope' }))['authorize'], reason);
  assert.equal(disabled(facts({ status: 'awaiting_scope' }))['refresh-checkpoint'], reason);
  assert.equal(disabled(facts({ status: 'awaiting_assessment' }))['assess'], reason);
  assert.equal(disabled(facts({ status: 'awaiting_answer' }))['answer'], reason);
  const timeout = disabled(facts({ status: 'blocked', stage: 'validation', rerunProblem: null }));
  assert.equal(timeout['rerun-checks'], reason);
  assert.equal(timeout['retry'], reason);
  assert.equal(timeout['revise'], null);
  assert.equal(disabled(facts({ status: 'blocked', stage: 'preparation' }))['retry-preparation'], reason);
  const orphaned = disabled(facts({ status: 'ready', stage: 'workspace', pending: true, releasable: true }));
  assert.equal(orphaned['recover'], null);
  assert.equal(orphaned['release-workspace'], null);
});

test('a planning conversation shows its questions, then a readable proposal ready for approval', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'grampus-view-kickoff-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Offline test');
  git('config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(repo, 'hello.js'), "console.log('hello');\n");
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const store = new Store(join(repo, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const plan = {
    brief: {
      title: 'Verify the greeting',
      outcome: 'Preserve the greeting',
      criteria: ['Print hello'],
      plan: 'Check it',
    },
    slices: [
      {
        mode: 'no_change',
        scope: { files: [] },
        validation: { file: 'node', args: ['--check', 'hello.js'] },
        acceptance: [{ file: 'node', args: ['hello.js'], expectedStdout: 'hello\n' }],
        message: 'Verify greeting',
      },
    ],
  };
  const reply = (value: Reply): TurnResult => ({ status: 'completed', reply: value, usage: null, error: null });
  const replies: TurnResult[] = [
    reply({
      kind: 'question',
      text: 'Confirm the greeting',
      questions: [{ id: 'greeting', prompt: 'Keep hello?', choices: ['yes', 'no'] }],
      findings: [],
    }),
    reply({ kind: 'message', text: JSON.stringify(plan), questions: [], findings: [] }),
  ];
  const prompts: string[] = [];
  const connector: Connector = async () => ({
    turn: async prompt => {
      prompts.push(prompt);
      return replies.shift()!;
    },
    interrupt: async () => {},
    close: async () => {},
  });
  const kickoffs = new Kickoffs(store, connector);
  const id = kickoffs.create({ repo, request: 'Check that the greeting still prints hello.', provider: 'claude' });
  await kickoffs.send(id);

  const asked = kickoffDetail(kickoffs.view(id), view, store.revision());
  assert.equal(asked.status, 'awaiting_human');
  assert.equal(asked.statusLabel, 'Your answer is needed');
  assert.deepEqual(asked.questions, [{ id: 'greeting', prompt: 'Keep hello?', suggestions: ['yes', 'no'] }]);
  const answer = asked.actions[0]!;
  assert.equal(answer.id, 'plan-answer');
  assert.equal(answer.request.path, `/api/kickoffs/${id}/plan`);
  assert.equal(answer.expected, kickoffs.view(id).turnKey);
  assert.deepEqual(
    answer.form?.fields.map(field => field.target),
    ['/answers/greeting'],
  );
  assert.deepEqual(
    asked.actions.map(item => item.id),
    ['plan-answer', 'update-context', 'update-references', 'reset', 'delete'],
  );

  // A failed planner worker is journaled; after a dashboard restart only the journal still knows it.
  assert.equal(asked.actionError, null);
  store.transaction(() =>
    store.appendSession(id, 'dashboard.action_failed', {
      action: 'plan',
      note: 'Planner worker stopped unexpectedly',
      reasonCode: null,
      exitCode: 1,
    }),
  );
  const failed = kickoffDetail(kickoffs.view(id), view, store.revision());
  assert.deepEqual(failed.actionError && { action: failed.actionError.action, message: failed.actionError.message }, {
    action: 'plan',
    message: 'Planner worker stopped unexpectedly',
  });
  assert.ok(failed.actionError?.at);

  await kickoffs.send(id, undefined, { greeting: 'yes' });
  const proposed = kickoffDetail(kickoffs.view(id), view, store.revision());
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /observable behaviour/);
    assert.match(prompt, /source-text searches/);
    assert.match(prompt, /keep the approach provisional/);
    assert.match(prompt, /If missing information changes the intended outcome/);
    assert.match(prompt, /conformance/);
    assert.match(prompt, /integration smoke test/);
  }
  assert.equal(asked.usage.headline.tokens, null);
  assert.equal(proposed.usage.turns, 2);
  assert.equal(proposed.actionError, null, 'a later planning turn resolves the failure');
  assert.equal(proposed.statusLabel, 'Plan proposed');
  assert.equal(proposed.title, 'Verify the greeting');
  assert.deepEqual(
    proposed.messages.map(message => [message.role, message.kind]),
    [
      ['user', 'message'],
      ['planner', 'message'],
      ['user', 'answers'],
      ['planner', 'proposal'],
    ],
  );
  assert.equal(proposed.messages[2]?.text, 'yes');
  assert.match(proposed.messages[3]?.text ?? '', /prepared a plan for “Verify the greeting”/);
  assert.equal(proposed.proposal?.plan.slices[0]?.delivery.mode, 'no_change');
  assert.deepEqual(JSON.parse(proposed.proposal.plan.rawPlan), kickoffs.view(id).candidate);
  const prepare = proposed.actions[0]!;
  assert.equal(prepare.id, 'prepare');
  assert.deepEqual(prepare.request.body, { digest: proposed.proposal?.digest });
  const home = overview(
    {
      tasks: [],
      unreadable: [],
      kickoffs: [kickoffs.view(id)],
      health: healthView(store),
      application: { version: '0.0.0', channel: 'development', build: null },
      journal: store.path,
      qualityPasses: [],
    },
    view,
    store.revision(),
  );
  assert.deepEqual(
    home.attention.map(item => [item.kind, item.kickoffId, item.actions.map(entry => entry.id)]),
    [['plan_ready', id, ['prepare', 'plan-message']]],
  );
  assert.equal(home.planning[0]?.provider.label, 'Claude');
  const taskId = kickoffs.prepare(id, proposed.proposal.digest);
  assert.equal(new GuidedTasks(store).get(taskId).status, 'draft');
  const converted = kickoffDetail(kickoffs.view(id), view, store.revision());
  assert.equal(converted.taskId, taskId);
  assert.deepEqual(converted.actions, []);
});
