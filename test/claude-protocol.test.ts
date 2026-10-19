import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSession, hasClaudeSubscription } from '../src/providers/claude.js';
import { claudeAccountSchema, isKnownClaudeMessageType } from '../src/providers/claude-protocol.js';
import { ProtocolError } from '../src/process/boundary.js';
import type { AgentEvent } from '../src/providers/types.js';

/** A fake SDK query that yields the given stream messages once a turn has been pushed. */
function fixture(messages: unknown[]) {
  const events: AgentEvent[] = [];
  let release: () => void = () => {};
  const started = new Promise<void>(resolve => {
    release = resolve;
  });
  const factory = ((options: { prompt: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of options.prompt) {
        release();
        break;
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        await started;
        for (const message of messages) yield message as SDKMessage;
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session: 'not a usage report' }),
      mcpServerStatus: async () => [{ name: 'docs', status: 'connected', extra: 1 }],
      accountInfo: async () => ({ apiProvider: 'firstParty', subscriptionType: 'max', futureField: true }),
      close() {},
      interrupt: async () => {},
    };
  }) as unknown as typeof query;
  const agent = new ClaudeSession(
    {
      cwd: process.cwd(),
      providerSessionId: 'session-1',
      model: null,
      signal: new AbortController().signal,
      emit: event => events.push(event),
    },
    factory,
  );
  return { agent, events };
}

// Recorded-style SDK messages with fields Grampus does not read.
const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'session-1',
  model: 'claude-opus',
  mcp_servers: [{ name: 'docs', status: 'connected' }],
  tools: ['ToolSearch'],
  uuid: 'u1',
};
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  modelUsage: { 'claude-opus': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, costUSD: 0.01 } },
  total_cost_usd: 0.01,
  structured_output: { kind: 'message', text: 'Done', questions: [], findings: [], extra: 'ignored' },
  duration_ms: 12,
  session_id: 'session-1',
};

test('Claude journals an unrecognised SDK message type once and still completes the turn', async () => {
  const { agent, events } = fixture([
    init,
    { type: 'future_event', payload: { token: 'secret-value', text: 'x' } },
    { type: 'future_event', payload: {} },
    { type: 'assistant', parent_tool_use_id: null, message: { usage: { input_tokens: 'many' } } },
    result,
  ]);
  try {
    const output = await agent.turn('Hello');
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.reply, { kind: 'message', text: 'Done', questions: [], findings: [] });
    assert.equal(output.usage?.inputTokens, 10);
  } finally {
    await agent.close();
  }
  const unrecognized = events.filter(event => event.type === 'protocol.unrecognized');
  assert.equal(unrecognized.length, 1);
  assert.doesNotMatch(JSON.stringify(unrecognized), /secret-value/);
  assert.equal(events.filter(event => event.type === 'protocol.malformed').length, 1);
});

test('a Claude result that does not match the pinned contract fails the turn with a protocol error', async () => {
  const { agent } = fixture([init, { type: 'result', subtype: 'success', is_error: 'no', modelUsage: {} }]);
  try {
    await assert.rejects(
      agent.turn('Hello'),
      (error: unknown) =>
        error instanceof ProtocolError && error.provider === 'claude' && error.messageType === 'result',
    );
  } finally {
    await agent.close();
  }
});

test('a Claude session that reports a different identity at init is refused', async () => {
  const { agent } = fixture([{ ...init, session_id: 42 }, result]);
  try {
    await assert.rejects(
      agent.turn('Hello'),
      (error: unknown) => error instanceof ProtocolError && error.messageType === 'system/init',
    );
  } finally {
    await agent.close();
  }
});

test('the SDK message type list and account contract match what Grampus relies on', () => {
  assert.equal(isKnownClaudeMessageType('result'), true);
  assert.equal(isKnownClaudeMessageType('future_event'), false);
  assert.equal(
    hasClaudeSubscription(claudeAccountSchema.parse({ apiProvider: 'firstParty', subscriptionType: 'Claude Max' })),
    true,
  );
  assert.equal(
    hasClaudeSubscription(
      claudeAccountSchema.parse({ apiProvider: 'firstParty', subscriptionType: 'max', apiKeySource: 'user' }),
    ),
    false,
  );
  assert.equal(claudeAccountSchema.safeParse({ apiProvider: 7 }).success, false);
});
