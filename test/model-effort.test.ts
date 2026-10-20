// Verifies effort reaches the pinned provider interfaces, with real RPC framing and an offline SDK.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CodexSession } from '../src/providers/codex.js';
import { ClaudeSession } from '../src/providers/claude.js';
import { RpcProcess } from '../src/process/process.js';
import type { AgentEvent } from '../src/providers/types.js';

test('Codex sends fixed effort on its turn and retains account observations without inventing quota consumed', async () => {
  const script = `
    const send = value => console.log(JSON.stringify(value));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'mcpServerStatus/list') { send({id:r.id,result:{data:[],nextCursor:null}}); return; }
      if (r.method !== 'turn/start') return;
      if (r.params.effort !== 'low') process.exit(2);
      send({id:r.id,result:{turn:{id:'turn'}}});
      send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1000}}}});
      send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:JSON.stringify({kind:'message',text:'Done',questions:[],findings:[]})}}});
      send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
    });`;
  const events: AgentEvent[] = [],
    rpc = new RpcProcess(process.execPath, ['-e', script]);
  const agent = new CodexSession(rpc, 'thread', event => events.push(event), undefined, undefined, 'low');
  try {
    assert.equal((await agent.turn('Work')).status, 'completed');
  } finally {
    await agent.close();
  }
  assert.equal(events.filter(event => event.type === 'subscription.observed').length, 1);
});

test('Claude passes fixed effort into the SDK and retains a reported subscription rejection', async () => {
  let started: () => void = () => {},
    captured: unknown;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const factory = ((request: { prompt: AsyncIterable<unknown>; options: unknown }) => {
    captured = request.options;
    void (async () => {
      for await (const _ of request.prompt) {
        started();
        break;
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        await ready;
        yield {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: 1000, rateLimitType: 'five_hour' },
        } as SDKMessage;
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          modelUsage: {},
          total_cost_usd: 0,
          errors: ['Subscription limit'],
        } as SDKMessage;
      },
      close() {},
      interrupt: async () => {},
      mcpServerStatus: async () => [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
    };
  }) as unknown as typeof query;
  const events: AgentEvent[] = [];
  const agent = new ClaudeSession(
    {
      cwd: process.cwd(),
      providerSessionId: null,
      model: 'chosen',
      effort: 'high',
      signal: new AbortController().signal,
      emit: event => events.push(event),
    },
    factory,
  );
  try {
    assert.equal((await agent.turn('Work')).status, 'failed');
  } finally {
    await agent.close();
  }
  assert.equal((captured as { effort: string }).effort, 'high');
  assert.equal((captured as { model: string }).model, 'chosen');
  assert.equal(events.filter(event => event.type === 'subscription.observed').length, 1);
});
