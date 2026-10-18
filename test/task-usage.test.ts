import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Sessions } from '../src/sessions.js';
import { Workflow } from '../src/workflow.js';
import { taskUsage, usageLines } from '../src/task-usage.js';
import type { Usage, Provider } from '../src/agents/types.js';

test('task usage counts cumulative sessions once, includes planning and marks incomplete observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const task = new Workflow(store).create({ title: 'Usage', outcome: 'Report measurements', criteria: ['Measured totals'], plan: 'Read retained usage' });
  const link = (provider: Provider, providerSessionId: string) => {
    const session = new Sessions(store).create(provider, process.cwd()); session.providerSessionId = providerSessionId;
    store.saveSession(session.id, session); store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
    store.appendSession(session.id, 'turn.requested', { runId: 'first' }); return session.id;
  };
  const usage = (inputTokens: number, cost: number | null = null): Usage => ({ scope: 'provider-session-cumulative', inputTokens,
    outputTokens: inputTokens / 2, cachedInputTokens: 0, estimatedCostUsd: cost, billedCostUsd: null });
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
  assert.equal(rows[0]!.inputTokens, 240); assert.equal(rows[0]!.sessions, 2);
  assert.equal(rows[0]!.estimatedCostUsd, null); assert.equal(rows[0]!.billedCostUsd, null);
  assert.equal(rows[1]!.inputTokens, 90); assert.equal(rows[1]!.estimatedCostUsd, 0.02);
  assert.ok(!rows[0]!.incomplete.includes('inputTokens'));
  store.appendSession(b, 'turn.requested', { runId: 'interrupted-with-no-usage' });
  store.appendSession(b, 'turn.result', { result: { usage: null } });
  link('codex', 'missing-thread');
  const partial = taskUsage(store, task.id)[0]!;
  assert.equal(partial.inputTokens, 240); assert.equal(partial.sessions, 3);
  assert.ok(partial.incomplete.includes('inputTokens'));
  assert.match(usageLines([partial]).join('\n'), /240 \(partial\)/);
  assert.match(usageLines([]).join('\n'), /unknown/);
});
