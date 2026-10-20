// Both providers can request only named approved commands and must retain ownership until settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexSession } from '../src/providers/codex.js';
import { RpcProcess } from '../src/process/process.js';
import { claudeImplementationTool } from '../src/providers/claude-implementation.js';
import { runImplementationTool } from '../src/providers/implementation-tools.js';
import { isExternalMcpTool } from '../src/providers/integrations.js';

test(
  'Codex awaits a controller-run check and receives its diagnostics during the turn',
  { timeout: 30_000 },
  async t => {
    const rpc = new RpcProcess(process.execPath, [
      '-e',
      `
    const send=value=>console.log(JSON.stringify(value));
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);
      if(r.method==='turn/start'){
        send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
        send({id:r.id,result:{turn:{id:'turn'}}});
        send({id:'check',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'check',tool:'grampus_run_check',arguments:{name:'validation'}}});
      }else if(r.id==='check'){
        if(!r.result?.success||!r.result.contentItems[0].text.includes('retained diagnostic'))process.exit(2);
        send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:JSON.stringify({kind:'message',text:'Fixed',questions:[],findings:[]})}}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      }else if(r.method==='mcpServerStatus/list')send({id:r.id,result:{data:[],nextCursor:null}});
    });`,
    ]);
    const names: string[] = [];
    const agent = new CodexSession(rpc, 'thread', () => {}, undefined, undefined, {
      commands: {
        run: async name => {
          names.push(name);
          await Promise.resolve();
          return { phase: 'failed', stderr: 'retained diagnostic' };
        },
      },
    });
    t.after(() => agent.close());
    assert.equal((await agent.turn('Implement')).status, 'completed');
    assert.deepEqual(names, ['validation']);
  },
);

test('Claude fences command dispatch and withholds results after losing ownership', async () => {
  assert.equal(isExternalMcpTool('mcp__grampus_implementation__grampus_run_check'), false);
  let active = false,
    calls = 0;
  const definition = claudeImplementationTool(
    {
      run: async () => {
        calls++;
        active = false;
        return { phase: 'passed' };
      },
    },
    () => active,
  );
  assert.equal((await definition.handler({ name: 'validation' }, undefined)).isError, true);
  assert.equal(calls, 0);
  active = true;
  const result = await definition.handler({ name: 'validation' }, undefined);
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('passed'));
});

test('command tool input cannot replace an approved executable or arguments', () => {
  const commands = {
    run: async () => {
      throw new Error('Must not dispatch');
    },
  };
  for (const input of [
    { name: 'validation', args: ['other'] },
    { name: 'validation', file: 'other.exe' },
    { name: '' },
  ])
    assert.throws(() => runImplementationTool(commands, input));
});
