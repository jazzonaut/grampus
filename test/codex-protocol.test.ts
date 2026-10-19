import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcProcess } from '../src/process/process.js';
import { CodexSession } from '../src/providers/codex.js';
import {
  accountReadSchema,
  classifyCodexNotification,
  codexFileChangeSchema,
  parseCodexResponse,
  threadStartSchema,
} from '../src/providers/codex-protocol.js';
import { BoundaryError, ProtocolError } from '../src/process/boundary.js';
import { boundaryLimits } from '../src/config/limits.js';
import type { AgentEvent } from '../src/providers/types.js';

// Recorded-style app-server messages: field names and nesting follow codex app-server v2 output,
// including fields Grampus does not read, so additive protocol changes stay covered.
const recorded = {
  turnStarted: { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } },
  agentMessage: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'msg_1', text: '{"kind":"message"}', phase: 'final_answer' },
  },
  tokenUsage: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: {
      total: {
        totalTokens: 1450,
        inputTokens: 1200,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 0,
        outputTokens: 250,
        reasoningOutputTokens: 40,
      },
      last: { totalTokens: 450, inputTokens: 400, cachedInputTokens: 300, outputTokens: 50, reasoningOutputTokens: 10 },
      modelContextWindow: 258400,
    },
  },
  turnCompleted: {
    threadId: 'thread-1',
    turn: {
      id: 'turn-1',
      items: [],
      status: 'failed',
      error: { message: 'Rate limited', codexErrorInfo: 'usageLimitExceeded' },
    },
  },
  error: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    error: { message: 'stream disconnected', codexErrorInfo: null, additionalDetails: null },
    willRetry: true,
  },
};

test('recorded Codex notifications parse, and fields Grampus does not read are tolerated and dropped', () => {
  const started = classifyCodexNotification('turn/started', recorded.turnStarted);
  assert.equal(started.kind, 'notification');
  assert.ok(started.kind === 'notification' && started.notification.method === 'turn/started');
  assert.deepEqual(started.notification.params, { threadId: 'thread-1', turn: { id: 'turn-1' } });

  const usage = classifyCodexNotification('thread/tokenUsage/updated', recorded.tokenUsage);
  assert.ok(usage.kind === 'notification' && usage.notification.method === 'thread/tokenUsage/updated');
  assert.equal(usage.notification.params.tokenUsage.total?.cachedInputTokens, 800);
  assert.equal(usage.notification.params.tokenUsage.total?.cacheWriteInputTokens, 0);
  assert.equal(usage.notification.params.tokenUsage.modelContextWindow, 258400);

  const completed = classifyCodexNotification('turn/completed', recorded.turnCompleted);
  assert.ok(completed.kind === 'notification' && completed.notification.method === 'turn/completed');
  assert.equal(completed.notification.params.turn.error?.message, 'Rate limited');

  const error = classifyCodexNotification('error', recorded.error);
  assert.ok(error.kind === 'notification' && error.notification.method === 'error');
  assert.equal(error.notification.params.willRetry, true);

  assert.equal(classifyCodexNotification('item/completed', recorded.agentMessage).kind, 'notification');
});

test('a malformed control notification is a categorised protocol error naming the method and field', () => {
  const error = (() => {
    try {
      classifyCodexNotification('turn/completed', { threadId: 'thread-1', turn: { id: 7, status: 'completed' } });
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.ok(error instanceof ProtocolError);
  assert.equal(error.provider, 'codex');
  assert.equal(error.messageType, 'turn/completed');
  assert.equal(error.kind, 'provider-protocol');
  assert.ok(
    error.issues.some(issue => issue.startsWith('params.turn.id')),
    error.issues.join('; '),
  );
  assert.match(error.message, /Codex protocol changed: turn\/completed/);
});

test('a malformed observational notification is reported for the journal and skipped, never thrown', () => {
  const result = classifyCodexNotification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    tokenUsage: { total: { inputTokens: 'many' } },
  });
  assert.equal(result.kind, 'malformed');
  assert.ok(result.kind === 'malformed' && result.issues.some(issue => issue.includes('inputTokens')));
});

test('unknown notifications are unrecognised with a bounded, sanitised excerpt; known chatter is ignored', () => {
  const secret = 'sk-live-0123456789';
  const result = classifyCodexNotification('thread/futureFeature/updated', {
    threadId: 'thread-1',
    accessToken: secret,
    note: `line one\nline two\u202e ${'x'.repeat(5000)}`,
    nested: { deeper: { deepest: { beyond: { value: 1 } } } },
    list: Array.from({ length: 40 }, (_, index) => index),
  });
  assert.equal(result.kind, 'unrecognized');
  assert.ok(result.kind === 'unrecognized');
  assert.doesNotMatch(result.excerpt, new RegExp(secret));
  assert.match(result.excerpt, /\[redacted\]/);
  assert.doesNotMatch(result.excerpt, /[\n\u202e]/);
  assert.ok(result.excerpt.length <= boundaryLimits.excerptCharacters + 1);
  assert.equal(classifyCodexNotification('thread/started', {}).kind, 'ignored');
  assert.equal(classifyCodexNotification('codex/event/agent_message_delta', {}).kind, 'ignored');
});

test('responses are parsed per method; extra fields pass and a changed shape names the method', () => {
  assert.equal(
    parseCodexResponse('account/read', accountReadSchema, {
      account: { type: 'chatgpt', email: 'user@example.invalid', planType: 'plus' },
      requiresOpenaiAuth: true,
    }).account?.type,
    'chatgpt',
  );
  assert.throws(
    () => parseCodexResponse('thread/start', threadStartSchema, { thread: { id: '' }, model: 'gpt' }),
    (error: unknown) =>
      error instanceof ProtocolError && error.messageType === 'thread/start' && /thread\.id/.test(error.message),
  );
  assert.equal(
    codexFileChangeSchema.safeParse({ path: 'a.txt', kind: { type: 'update', move_path: 'b.txt' }, diff: '' }).success,
    false,
  );
});

function session(behaviour: string, events: AgentEvent[]) {
  const script = `
    const send = value => console.log(JSON.stringify(value));
    const reply = { kind: 'message', text: 'fixture', questions: [], findings: [] };
    const note = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'mcpServerStatus/list') { send({ id: r.id, result: { data: [], nextCursor: null } }); return; }
      ${behaviour}
    });
  `;
  return new CodexSession(new RpcProcess(process.execPath, ['-e', script]), 'thread-1', event => events.push(event));
}

test('a live Codex turn journals each unrecognised method once and still completes', async () => {
  const events: AgentEvent[] = [];
  const agent = session(
    `if (r.method === 'turn/start') {
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      note('turn/started', { turn: { id: 'turn-1' } });
      note('thread/futureFeature/updated', { turnId: 'turn-1', detail: 'first' });
      note('thread/futureFeature/updated', { turnId: 'turn-1', detail: 'second' });
      note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 'x' } } });
      note('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'm', text: JSON.stringify(reply), extra: true } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed', durationMs: 5 } });
    }`,
    events,
  );
  try {
    const result = await agent.turn('Hello');
    assert.equal(result.status, 'completed');
    assert.equal(result.reply?.text, 'fixture');
  } finally {
    await agent.close();
  }
  const unrecognized = events.filter(event => event.type === 'protocol.unrecognized');
  assert.equal(unrecognized.length, 1);
  assert.deepEqual(Object.keys(unrecognized[0]?.data as object).sort(), ['excerpt', 'messageType', 'provider']);
  assert.equal(events.filter(event => event.type === 'protocol.malformed').length, 1);
  assert.equal(
    events.some(event => event.type === 'usage.updated'),
    false,
  );
});

test('a live Codex turn whose completion is malformed fails with a protocol error instead of guessing', async () => {
  const agent = session(
    `if (r.method === 'turn/start') {
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      note('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('turn/completed', { turn: { status: 'completed' } });
    }`,
    [],
  );
  try {
    await assert.rejects(
      agent.turn('Hello'),
      (error: unknown) => error instanceof BoundaryError && /turn\/completed/.test(error.message),
    );
  } finally {
    await agent.close();
  }
});

test('a live Codex turn rejects an agent message that is not text', async () => {
  const agent = session(
    `if (r.method === 'turn/start') {
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      note('item/completed', { item: { type: 'agentMessage', text: { kind: 'message' } } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }`,
    [],
  );
  try {
    await assert.rejects(
      agent.turn('Hello'),
      (error: unknown) => error instanceof ProtocolError && error.messageType === 'item agentMessage',
    );
  } finally {
    await agent.close();
  }
});
