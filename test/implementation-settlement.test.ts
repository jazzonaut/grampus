// A provider's terminal notification cannot overtake controller-owned diagnostic settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { RpcProcess } from '../src/process/process.js';
import { CodexSession } from '../src/providers/codex.js';

test('a premature terminal notification waits for an outstanding diagnostic and retains its tool response', async t => {
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
        send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:JSON.stringify({kind:'message',text:'Done',questions:[],findings:[]})}}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      } else if(r.id==='check') send({method:'fixture/checkResponse',params:{success:r.result?.success}});
      else if(r.method==='mcpServerStatus/list') send({id:r.id,result:{data:[],nextCursor:null}});
    });
  `,
  ]);
  let release!: () => void;
  const command = new Promise<void>(resolve => {
    release = resolve;
  });
  let terminal!: () => void, response!: (success: boolean) => void;
  const terminalSeen = new Promise<void>(resolve => {
    terminal = resolve;
  });
  const responseSeen = new Promise<boolean>(resolve => {
    response = resolve;
  });
  rpc.onMessage(message => {
    if (message.method === 'turn/completed') terminal();
    if (message.method === 'fixture/checkResponse') response((message.params as { success: boolean }).success);
  });
  const agent = new CodexSession(rpc, 'thread', () => {}, undefined, undefined, {
    commands: {
      run: async () => {
        await command;
        return { phase: 'passed' };
      },
    },
  });
  t.after(() => agent.close());
  let settled = false;
  const turn = agent.turn('Implement').finally(() => {
    settled = true;
  });
  await terminalSeen;
  await setImmediate();
  try {
    assert.equal(settled, false, 'provider completion must wait for the controller diagnostic');
  } finally {
    release();
    await turn;
  }
  assert.equal(await responseSeen, true);
});
