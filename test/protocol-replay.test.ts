// Drift canary: recorded provider exchanges replayed through the real adapters. When Codex or the Claude
// Agent SDK changes its protocol, re-record the fixture (see each fixture's provenance); these tests then
// show which message Grampus no longer understands, instead of a live task failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { codexAppServerArguments, codexHandshake, connectCodex, hasCodexSubscription } from '../src/providers/codex.js';
import { connectClaude } from '../src/providers/claude.js';
import { claudeExecutable } from '../src/providers/executables.js';
import { classifyCodexNotification } from '../src/providers/codex-protocol.js';
import type { AgentEvent, ConnectOptions, Usage } from '../src/providers/types.js';
import { protocolFixture, replayServer } from './helpers/protocol-replay.js';
import * as claudeFixture from './fixtures/protocol/claude-turn.js';

const options = (events: AgentEvent[]): ConnectOptions => ({
  cwd: tmpdir(),
  providerSessionId: null,
  model: null,
  signal: new AbortController().signal,
  emit: event => events.push(event),
});
const ofType = (events: AgentEvent[], type: string) => events.filter(event => event.type === type);
const expectedReply = {
  kind: 'message',
  text: 'The parser already rejects empty input; no change is needed.',
  questions: [],
  findings: [],
  lenses: null,
};

test('the recorded Codex handshake replays through the adapter handshake and its notifications classify', async t => {
  const rpc = replayServer('codex-handshake.recorded.json');
  t.after(() => rpc.close());
  const handshake = await codexHandshake(rpc);
  assert.equal(handshake.account?.type, 'chatgpt');
  assert.ok(hasCodexSubscription(handshake));
  assert.ok(codexAppServerArguments().includes('forced_login_method="chatgpt"'));
  const recorded = JSON.parse(readFileSync(protocolFixture('codex-handshake.recorded.json'), 'utf8')) as {
    exchange: { server?: { method?: string; params?: unknown } }[];
  };
  const kinds = recorded.exchange.flatMap(entry =>
    entry.server?.method
      ? [[entry.server.method, classifyCodexNotification(entry.server.method, entry.server.params).kind]]
      : [],
  );
  // account/updated is deliberately ignored; remoteControl/status/changed is new in 0.163 and reported once as drift.
  assert.deepEqual(kinds, [
    ['remoteControl/status/changed', 'unrecognized'],
    ['account/updated', 'ignored'],
  ]);
});

test('a recorded Codex conversation turn replays to the typed events, usage and structured reply', async t => {
  const events: AgentEvent[] = [];
  const session = await connectCodex(options(events), () => replayServer('codex-turn.json'));
  t.after(() => session.close());
  const result = await session.turn('Is a change needed for empty input?');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reply, expectedReply);
  assert.equal(result.error, null);
  assert.deepEqual(result.usage, {
    scope: 'provider-session-cumulative',
    inputTokens: 5200,
    outputTokens: 96,
    cachedInputTokens: 4000,
    cacheWriteInputTokens: 0,
    estimatedCostUsd: null,
    billedCostUsd: null,
  } satisfies Usage);
  assert.deepEqual(ofType(events, 'session.connected')[0]?.data, {
    providerSessionId: '019a0000-0000-7000-8000-000000000001',
    model: 'gpt-5.5-codex',
    auth: 'subscription',
  });
  assert.deepEqual(ofType(events, 'turn.started').at(-1)?.data, {
    providerTurnId: '019a0000-0000-7000-8000-000000000002',
  });
  assert.equal(
    ofType(events, 'output.delta')
      .map(event => (event.data as { text: string }).text)
      .join(''),
    JSON.stringify(expectedReply),
  );
  assert.deepEqual(ofType(events, 'context.updated')[0]?.data, { inputTokens: 5200, windowTokens: 272000 });
  assert.deepEqual(
    ofType(events, 'protocol.unrecognized').map(event => (event.data as { messageType: string }).messageType),
    ['remoteControl/status/changed'],
  );
  const servers = ofType(events, 'integrations.updated').map(event => event.data);
  assert.equal(servers.length, 2, 'MCP status is reported after connecting and after the turn');
  assert.deepEqual(servers[0], { servers: [{ name: 'docs', status: 'connected', tools: 1, auth: 'unsupported' }] });
  assert.equal(ofType(events, 'protocol.malformed').length, 0);
});

/** A recorded SDK stream: control responses at once, the turn's messages after the first user message. */
function recordedQuery(seen: { options?: Record<string, unknown> }) {
  return (({
    prompt,
    options: queryOptions,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Record<string, unknown>;
  }) => {
    seen.options = queryOptions;
    const session = String(queryOptions['sessionId'] ?? queryOptions['resume']);
    const bind = (message: SDKMessage): SDKMessage =>
      JSON.parse(JSON.stringify(message).replaceAll(claudeFixture.sessionPlaceholder, session)) as SDKMessage;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _message of prompt) for (const message of claudeFixture.turn) yield bind(message);
      },
      accountInfo: async () => claudeFixture.accountInfo,
      mcpServerStatus: async () => claudeFixture.mcpStatus,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error('Usage samples are not part of this recording');
      },
      interrupt: async () => {},
      close() {},
    };
  }) as unknown as typeof query;
}

test('a recorded Claude SDK turn replays to the typed events, usage and structured reply', async t => {
  const events: AgentEvent[] = [];
  const seen: { options?: Record<string, unknown> } = {};
  const session = await connectClaude(options(events), recordedQuery(seen));
  t.after(() => session.close());
  // The adapter starts exactly the executable doctor reports, with the reply format it validates.
  assert.equal(seen.options?.['pathToClaudeCodeExecutable'], claudeExecutable().path ?? undefined);
  assert.equal((seen.options?.['outputFormat'] as { type: string }).type, 'json_schema');
  assert.equal(seen.options?.['includePartialMessages'], true);
  assert.equal((seen.options?.['env'] as Record<string, unknown>)['ANTHROPIC_API_KEY'], undefined);
  const result = await session.turn('Is a change needed for empty input?');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reply, expectedReply);
  assert.deepEqual(result.usage, {
    scope: 'provider-session-cumulative',
    complete: true,
    inputTokens: 1200,
    outputTokens: 96,
    cachedInputTokens: 4000,
    cacheWriteInputTokens: 300,
    estimatedCostUsd: 0.0425,
    billedCostUsd: null,
  } satisfies Usage);
  const connected = ofType(events, 'session.connected').map(event => event.data as { model?: string | null });
  assert.equal(connected.at(-1)?.model, 'claude-opus-5-5', 'system/init names the model that actually runs');
  assert.equal(ofType(events, 'turn.started').length, 1);
  assert.equal(
    ofType(events, 'output.delta')
      .map(event => (event.data as { text: string }).text)
      .join(''),
    JSON.stringify(claudeFixture.reply),
  );
  assert.deepEqual(ofType(events, 'context.updated')[0]?.data, { inputTokens: 1200 + 4000 + 300 });
  assert.deepEqual(ofType(events, 'integrations.updated').at(-1)?.data, {
    servers: [{ name: 'docs', status: 'connected' }],
  });
  assert.equal(ofType(events, 'protocol.malformed').length + ofType(events, 'protocol.unrecognized').length, 0);
});
