// Real usage journals establish cumulative attribution, cache accounting and conservative dispatch headroom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import { normalizeWorkflowPolicy } from '../src/domain/workflow-policy.js';
import { spendingStatus, spendingStop } from '../src/orchestration/guided/spending.js';
import { spendingView } from '../src/server/view-model/spending.js';
import type { Usage, Provider } from '../src/providers/types.js';
import { taskRecord, guidedRecord } from './helpers/task-records.js';

function fixture(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.save('task', taskRecord('task'));
  const turn = (provider: Provider, thread: string, usage: Partial<Usage> | null, settled = true) => {
    const session = new Sessions(store).create(provider, process.cwd());
    session.providerSessionId = thread;
    store.saveSession(session.id, session);
    store.append('task', 1, 'guided.kickoff_linked', { sessionId: session.id });
    store.appendSession(session.id, 'turn.requested', { stage: 'planning' });
    const measured: Usage | null = usage && {
      scope: 'provider-session-cumulative',
      complete: true,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostUsd: null,
      billedCostUsd: null,
      ...usage,
    };
    if (settled) store.appendSession(session.id, 'turn.result', { result: { status: 'completed', usage: measured } });
    else if (measured) store.appendSession(session.id, 'usage.updated', { data: measured });
    return session.id;
  };
  return { store, turn, usage: () => taskUsage(store, 'task') };
}

test('spending defaults are approval-bound and all task limits are bounded integers', () => {
  const policy = normalizeWorkflowPolicy(undefined);
  assert.equal(policy.maxTaskTurns, 20);
  assert.equal(policy.maxTaskTokens, 0);
  assert.equal(normalizeWorkflowPolicy({ maxTaskTurns: 1, maxTaskTokens: 1 }).maxTaskTokens, 1);
  for (const value of [0, -1, 1.5, 1001, Infinity, '20', null])
    assert.throws(() => normalizeWorkflowPolicy({ maxTaskTurns: value }));
  for (const value of [-1, 1.5, 1_000_000_001, Infinity, '0', null])
    assert.throws(() => normalizeWorkflowPolicy({ maxTaskTokens: value }));
});

test('first turn has known zero spend; cumulative sessions and provider caches count once', t => {
  const f = fixture(t),
    policy = normalizeWorkflowPolicy({ maxTaskTokens: 200 });
  assert.equal(spendingStatus(f.usage(), policy).tokens, 0);
  assert.equal(spendingStatus(f.usage(), policy).status, 'available');
  f.turn('codex', 'shared', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 });
  f.turn('codex', 'shared', { inputTokens: 150, outputTokens: 20, cachedInputTokens: 120 });
  f.turn('claude', 'other', { inputTokens: 5, outputTokens: 3, cachedInputTokens: 7, cacheWriteInputTokens: 11 });
  const measured = spendingStatus(f.usage(), policy);
  assert.equal(measured.tokens, 196);
  assert.equal(measured.remainingTokens, 4);
  assert.equal(measured.turns, 3);
  assert.equal(measured.tokenCompleteness, 'complete');
  assert.equal(spendingStatus(f.usage(), { ...policy, maxTaskTokens: 196 }).status, 'token_limit');
  assert.equal(spendingView(f.usage(), policy).turnsLabel, '3 of 20 agent turns used; 17 remaining.');
});

test('unknown and partial measurements refuse token headroom while a disabled token gate keeps the turn bound', t => {
  const f = fixture(t),
    policy = normalizeWorkflowPolicy({ maxTaskTokens: 100 });
  f.turn('claude', 'missing', { inputTokens: 5, cacheWriteInputTokens: null });
  const unknown = spendingStatus(f.usage(), policy);
  assert.equal(unknown.tokenCompleteness, 'partial');
  assert.equal(unknown.status, 'usage_unknown');
  assert.equal(unknown.remainingTokens, null);
  assert.equal(spendingStatus(f.usage(), { ...policy, maxTaskTokens: 5 }).status, 'token_limit');
  assert.equal(spendingStatus(f.usage(), { ...policy, maxTaskTokens: 0 }).status, 'available');
  assert.equal(spendingStatus(f.usage(), { ...policy, maxTaskTokens: 0, maxTaskTurns: 1 }).status, 'turn_limit');
});

test('an unsettled turn cannot establish remaining tokens and unknown is never zero', t => {
  const f = fixture(t),
    policy = normalizeWorkflowPolicy({ maxTaskTokens: 100 });
  f.turn('codex', 'no-result', { inputTokens: 2 }, false);
  assert.equal(spendingStatus(f.usage(), policy).status, 'usage_unknown');
  f.turn('claude', 'no-measurements', null);
  const measured = spendingStatus(f.usage(), policy);
  assert.equal(measured.tokenCompleteness, 'partial');
  assert.equal(measured.tokens, 2);
});

test('a settled failure without final usage cannot turn its last live sample into known headroom', t => {
  const f = fixture(t),
    policy = normalizeWorkflowPolicy({ maxTaskTokens: 100 });
  const sessionId = f.turn('codex', 'lost-final', { inputTokens: 2 }, false);
  f.store.appendSession(sessionId, 'turn.result', { result: { status: 'interrupted', usage: null } });
  assert.equal(spendingStatus(f.usage(), policy).status, 'usage_unknown');
});

test('a missing final counter cannot inherit certainty from an earlier live observation', t => {
  const f = fixture(t),
    policy = normalizeWorkflowPolicy({ maxTaskTokens: 100 });
  const sessionId = f.turn('codex', 'missing-final-input', { inputTokens: 2 }, false);
  f.store.appendSession(sessionId, 'turn.result', {
    result: {
      status: 'completed',
      usage: {
        scope: 'provider-session-cumulative',
        complete: true,
        inputTokens: null,
        outputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        estimatedCostUsd: null,
        billedCostUsd: null,
      },
    },
  });
  const measured = spendingStatus(f.usage(), policy);
  assert.equal(measured.tokens, 3);
  assert.equal(measured.tokenCompleteness, 'partial');
  assert.equal(measured.status, 'usage_unknown');
});

test('exhaustion gates every agent stage but never blocks checks, recovery settlement or verified delivery', t => {
  const f = fixture(t);
  f.turn('codex', 'spent', null);
  const state = guidedRecord();
  state.plan.workflowPolicy.maxTaskTurns = 1;
  for (const stage of ['implementation', 'quality_pass', 'review'] as const) {
    const blocked = spendingStop(f.store, 'task', { ...state, stage });
    assert.equal(blocked!.reason.code, 'TASK_TURN_LIMIT');
  }
  for (const stage of ['validation', 'verification', 'delivery', 'complete'] as const)
    assert.equal(spendingStop(f.store, 'task', { ...state, stage }), null);
});
