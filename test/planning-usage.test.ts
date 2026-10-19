// Planning usage remains available before conversion and shares task accounting after conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { planningUsage, taskUsage } from '../src/reporting/task-usage.js';
import { usageView } from '../src/server/view-model/usage.js';
import { Workflow } from '../src/domain/workflow.js';

test('planning reports unknown, live and settled usage without a task or double counting resumed turns', t => {
  const folder = mkdtempSync(join(tmpdir(), 'grampus-planning-usage-'));
  const store = new Store(join(folder, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const sessions = new Sessions(store);
  const session = sessions.create('claude', process.cwd());
  assert.equal(usageView(planningUsage(store, session.id)).headline.tokens, null);
  const first = sessions.claim(session.id, 'Plan');
  const sample = {
    scope: 'provider-session-cumulative' as const,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostUsd: null,
    billedCostUsd: null,
    complete: false,
  };
  sessions.event(session.id, first.runId, { type: 'usage.updated', data: sample });
  const live = usageView(planningUsage(store, session.id));
  assert.equal(live.headline.tokens, 120);
  assert.equal(live.headline.completeness, 'live');
  sessions.settle(
    session.id,
    first.runId,
    {
      status: 'completed',
      reply: { kind: 'message', text: 'Plan', questions: [], findings: [] },
      error: null,
      usage: { ...sample, complete: true },
    },
    true,
  );
  const next = sessions.claim(session.id, 'Refine');
  sessions.settle(
    session.id,
    next.runId,
    {
      status: 'completed',
      reply: { kind: 'message', text: 'Plan', questions: [], findings: [] },
      error: null,
      usage: { ...sample, inputTokens: 150, outputTokens: 30, complete: true },
    },
    true,
  );
  const planned = planningUsage(store, session.id);
  assert.equal(planned.providers[0]?.inputTokens, 150);
  assert.equal(planned.turns, 2);
  const task = new Workflow(store).create({ title: 'Plan', outcome: 'Work', criteria: ['Works'], plan: 'Implement' });
  store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: session.id });
  assert.deepEqual(taskUsage(store, task.id), planned);
});
