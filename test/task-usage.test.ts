import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { Workflow } from '../src/domain/workflow.js';
import { taskUsage, usageLines } from '../src/reporting/task-usage.js';
import type { Usage, Provider } from '../src/providers/types.js';

test('task usage counts cumulative sessions once, includes planning and marks incomplete observations', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = new Workflow(store).create({
    title: 'Usage',
    outcome: 'Report measurements',
    criteria: ['Measured totals'],
    plan: 'Read retained usage',
  });
  const link = (provider: Provider, providerSessionId: string) => {
    const session = new Sessions(store).create(provider, process.cwd());
    session.providerSessionId = providerSessionId;
    store.saveSession(session.id, session);
    store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
    store.appendSession(session.id, 'turn.requested', { runId: 'first' });
    return session.id;
  };
  const usage = (inputTokens: number, cost: number | null = null): Usage => ({
    scope: 'provider-session-cumulative',
    inputTokens,
    outputTokens: inputTokens / 2,
    cachedInputTokens: 0,
    estimatedCostUsd: cost,
    billedCostUsd: null,
  });
  const a = link('codex', 'shared-thread');
  store.appendSession(a, 'usage.updated', { data: usage(100) });
  store.appendSession(a, 'usage.updated', { data: usage(150) });
  store.appendSession(a, 'turn.result', { result: { usage: usage(150) } });
  const resumed = link('codex', 'shared-thread');
  store.appendSession(resumed, 'turn.result', { result: { usage: usage(200) } });
  const b = link('codex', 'independent-thread');
  store.appendSession(b, 'turn.result', { result: { usage: usage(40) } });
  const c = link('claude', 'claude-thread');
  store.appendSession(c, 'turn.result', { result: { usage: usage(90, 0.02) } });
  const rows = taskUsage(store, task.id);
  assert.equal(rows[0]!.inputTokens, 240);
  assert.equal(rows[0]!.sessions, 2);
  assert.equal(rows[0]!.estimatedCostUsd, null);
  assert.equal(rows[0]!.billedCostUsd, null);
  assert.equal(rows[1]!.inputTokens, 90);
  assert.equal(rows[1]!.estimatedCostUsd, 0.02);
  assert.ok(!rows[0]!.incomplete.includes('inputTokens'));
  store.appendSession(b, 'turn.requested', { runId: 'interrupted-with-no-usage' });
  store.appendSession(b, 'turn.result', { result: { usage: null } });
  link('codex', 'missing-thread');
  const partial = taskUsage(store, task.id)[0]!;
  assert.equal(partial.inputTokens, 240);
  assert.equal(partial.sessions, 3);
  assert.ok(partial.incomplete.includes('inputTokens'));
  assert.match(usageLines([partial]).join('\n'), /240 \(partial\)/);
  assert.match(usageLines([]).join('\n'), /unknown/);
});

test('live usage remains partial, refreshes after interruption and is replaced by a final snapshot', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = new Workflow(store).create({
    title: 'Live usage',
    outcome: 'Show live totals',
    criteria: ['Update while running'],
    plan: 'Read snapshots',
  });
  const sessions = new Sessions(store),
    session = sessions.create('claude', process.cwd());
  store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
  const claim = sessions.claim(session.id, 'Work');
  const usage: Usage = {
    scope: 'provider-session-cumulative',
    complete: false,
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 2000,
    estimatedCostUsd: 0.2,
    billedCostUsd: null,
  };
  sessions.event(session.id, claim.runId, { type: 'usage.updated', data: usage });
  const live = taskUsage(store, task.id)[0]!;
  assert.equal(live.inputTokens, 100);
  assert.equal(live.activeSessions, 1);
  assert.equal(live.observedSessions, 1);
  assert.ok(live.incomplete.includes('inputTokens'));
  assert.ok(live.updatedAt);
  sessions.settle(session.id, claim.runId, { status: 'interrupted', reply: null, usage: null, error: 'Stopped' }, true);
  const stopped = taskUsage(store, task.id)[0]!;
  assert.equal(stopped.inputTokens, 100);
  assert.equal(stopped.activeSessions, 0);
  assert.ok(stopped.incomplete.includes('inputTokens'));
  store.appendSession(session.id, 'usage.updated', { data: { ...usage, complete: true, inputTokens: 120 } });
  const final = taskUsage(store, task.id)[0]!;
  assert.equal(final.inputTokens, 120);
  assert.equal(final.sessions, 1);
  assert.equal(final.incomplete.length, 0);
});
