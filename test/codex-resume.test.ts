// Exercises large saved conversations through the real Codex adapter and bounded RPC transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { processLimits } from '../src/config/limits.js';
import { RpcProcess } from '../src/process/process.js';
import { connectCodex } from '../src/providers/codex.js';
import type { AgentEvent } from '../src/providers/types.js';

const threadId = 'saved-review-thread';
const reply = { kind: 'review', text: 'Reviewed the repaired artifact.', questions: [], findings: [] };

// Models app-server's resume response: excludeTurns affects the response, not the saved conversation.
function savedConversation(): RpcProcess {
  return new RpcProcess(process.execPath, [
    '-e',
    `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') send({ id: r.id, result: {} });
      if (r.method === 'account/read') send({ id: r.id, result: { account: { type: 'chatgpt' } } });
      if (r.method === 'config/read') send({ id: r.id, result: { config: {} } });
      if (r.method === 'thread/resume') {
        if (r.params.threadId !== ${JSON.stringify(threadId)}) process.exit(3);
        send({ id: r.id, result: {
          thread: { id: r.params.threadId, turns: r.params.excludeTurns ? [] : [
            { items: [{ text: 'x'.repeat(${processLimits.rpcLineBytes + 1}) }] }
          ] },
          model: 'fixture', approvalPolicy: 'untrusted', sandbox: {type:'readOnly',networkAccess:false}
        } });
      }
      if (r.method === 'mcpServerStatus/list') send({ id: r.id, result: { data: [], nextCursor: null } });
      if (r.method === 'turn/start') {
        if (r.params.threadId !== ${JSON.stringify(threadId)}) process.exit(4);
        send({ id: r.id, result: { turn: { id: 'new-review-turn' } } });
        send({ method: 'item/completed', params: { threadId: r.params.threadId,
          turnId: 'new-review-turn', item: { type: 'agentMessage', text: ${JSON.stringify(JSON.stringify(reply))} } } });
        send({ method: 'turn/completed', params: { threadId: r.params.threadId,
          turn: { id: 'new-review-turn', status: 'completed' } } });
      }
    });
    `,
  ]);
}

test('Codex resumes a conversation whose saved turns exceed the RPC limit and completes a new review', async t => {
  const events: AgentEvent[] = [];
  const session = await connectCodex(
    {
      cwd: tmpdir(),
      providerSessionId: threadId,
      model: null,
      signal: new AbortController().signal,
      emit: event => events.push(event),
    },
    savedConversation,
  );
  t.after(() => session.close());
  assert.deepEqual(events.find(event => event.type === 'session.connected')?.data, {
    providerSessionId: threadId,
    model: 'fixture',
    auth: 'subscription',
  });
  const result = await session.turn('Review the repaired artifact in this conversation.');
  assert.equal(result.status, 'completed', result.error ?? undefined);
  assert.equal(result.reply?.kind, 'review');
  assert.equal(result.reply?.text, reply.text);
  assert.equal(result.error, null);
});

test('RPC still refuses oversized history when a client requests full saved turns', async t => {
  const rpc = savedConversation();
  t.after(() => rpc.close());
  await assert.rejects(rpc.request('thread/resume', { threadId }), /RPC message too large/);
});
