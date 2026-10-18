import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { query, SDKMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSession } from '../src/providers/claude.js';
import type { AgentEvent, Usage } from '../src/providers/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const model = (tokens: number): ModelUsage => ({
  inputTokens: tokens,
  outputTokens: tokens * 2,
  cacheReadInputTokens: tokens * 10,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: tokens / 1000,
  contextWindow: 200000,
  maxOutputTokens: 64000,
});
function fixture(sample: () => Promise<unknown>) {
  const events: AgentEvent[] = [],
    final = deferred<SDKMessage>();
  const factory = (() => ({
    async *[Symbol.asyncIterator]() {
      yield await final.promise;
    },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sample,
    mcpServerStatus: async () => [],
    close() {
      final.resolve({ type: 'system', subtype: 'status', status: null } as SDKMessage);
    },
  })) as unknown as typeof query;
  const agent = new ClaudeSession(
    {
      cwd: process.cwd(),
      providerSessionId: null,
      model: null,
      signal: new AbortController().signal,
      emit: event => events.push(event),
    },
    factory,
  );
  const finish = () =>
    final.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      modelUsage: { model: model(30) },
      total_cost_usd: 0.03,
      structured_output: { kind: 'message', text: 'Done', questions: [], findings: [] },
    } as unknown as SDKMessage);
  const usages = () => events.filter(event => event.type === 'usage.updated').map(event => event.data as Usage);
  return { agent, events, finish, usages };
}

test('Claude publishes cumulative usage during a turn and the final snapshot replaces interim totals', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let tokens = 10;
  const f = fixture(async () => ({
    session: { model_usage: { model: model(tokens) }, total_cost_usd: tokens / 1000 },
  }));
  t.after(() => f.agent.close());
  const turning = f.agent.turn('Implement');
  t.mock.timers.tick(15_000);
  await setImmediate();
  assert.equal(f.usages().at(-1)?.inputTokens, 10);
  assert.equal(f.usages().at(-1)?.complete, false);
  tokens = 20;
  t.mock.timers.tick(15_000);
  await setImmediate();
  assert.equal(f.usages().at(-1)?.outputTokens, 40);
  assert.equal(f.usages().at(-1)?.estimatedCostUsd, 0.02);
  f.finish();
  const result = await turning;
  assert.equal(result.status, 'completed');
  assert.equal(result.usage?.inputTokens, 30);
  assert.equal(result.usage?.complete, true);
  assert.equal(f.usages().at(-1)?.inputTokens, 30);
  assert.equal(result.usage?.billedCostUsd, null);
});

test('missing usage support does not interrupt Claude and late samples cannot overwrite the final result', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = deferred<unknown>();
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new Error('Usage unavailable');
    return pending.promise;
  });
  t.after(() => f.agent.close());
  const turning = f.agent.turn('Implement');
  t.mock.timers.tick(15_000);
  await setImmediate();
  assert.equal(f.usages().length, 0);
  t.mock.timers.tick(15_000);
  await setImmediate();
  f.finish();
  assert.equal((await turning).status, 'completed');
  pending.resolve({ session: { model_usage: { model: model(1) }, total_cost_usd: 0.001 } });
  await setImmediate();
  assert.equal(f.usages().at(-1)?.inputTokens, 30);
  assert.equal(f.usages().at(-1)?.complete, true);
});
