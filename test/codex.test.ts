import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcProcess } from '../src/process.js';
import { CodexSession } from '../src/agents/codex.js';
import type { AgentEvent } from '../src/agents/types.js';

const reply = { kind: 'message', text: 'fixture', questions: [], findings: [] };
function fixture(behavior: string, events: AgentEvent[] = [], onEvent: (event: AgentEvent) => void = () => {}) {
  const script = `
    const send = value => console.log(JSON.stringify(value));
    const reply = ${JSON.stringify(reply)};
    const note = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      ${behavior}
    });
  `;
  const rpc = new RpcProcess(process.execPath, ['-e', script]);
  return new CodexSession(rpc, 'thread-1', event => { events.push(event); onEvent(event); });
}

test('Codex handles notifications arriving before turn/start acknowledgement and ignores other threads', async () => {
  const events: AgentEvent[] = [];
  const agent = fixture(`
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      note('item/completed', { threadId: 'other', item: { type: 'agentMessage', text: 'invalid' } });
      note('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 } } });
      note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 70 } } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
  `, events);
  try {
    const output = await agent.turn('Hello');
    assert.deepEqual(output.reply, reply);
    assert.equal(output.usage?.inputTokens, 150);
    assert.equal(output.usage?.billedCostUsd, null);
    assert.ok(events.some(e => e.type === 'turn.started'));
  } finally { await agent.close(); }
});

test('Codex interruption requires a terminal notification, not just the RPC receipt', async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const agent = fixture(`
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
    if (r.method === 'turn/interrupt') {
      send({ id: r.id, result: {} });
      setTimeout(() => note('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }), 50);
    }
  `, [], event => { if (event.type === 'turn.started') notifyStarted(); });
  try {
    const output = agent.turn('Long task');
    await started;
    let finished = false;
    void output.then(() => { finished = true; });
    await agent.interrupt();
    assert.equal(finished, false);
    assert.equal((await output).status, 'interrupted');
  } finally { await agent.close(); }
});

test('Codex process death cannot be mistaken for successful completion', async () => {
  const agent = fixture(`if (r.method === 'turn/start') { send({ id: r.id, result: { turn: { id: 'turn-1' } } }); process.exit(2); }`);
  try { await assert.rejects(agent.turn('Hello'), /exited/); }
  finally { await agent.close(); }
});

test('Codex malformed output and provider failures are not accepted as successful replies', async () => {
  const malformed = fixture(`if (r.method === 'turn/start') {
    send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    note('item/completed', { item: { type: 'agentMessage', text: 'not JSON' } });
    note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  }`);
  try { await assert.rejects(malformed.turn('Hello')); }
  finally { await malformed.close(); }
  const failed = fixture(`if (r.method === 'turn/start') {
    send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    note('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'Provider unavailable' } } });
  }`);
  try {
    const output = await failed.turn('Hello');
    assert.equal(output.status, 'failed');
    assert.equal(output.error, 'Provider unavailable');
    assert.equal(output.reply, null);
  } finally { await failed.close(); }
});
