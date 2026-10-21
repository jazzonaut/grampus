// Connection permissions are proved before planning, review or implementation can dispatch a turn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { RpcProcess } from '../src/process/process.js';
import { connectCodex } from '../src/providers/codex.js';

test('read-only connections refuse missing, writable or network-enabled sandbox confirmation', async t => {
  for (const sandbox of [undefined, { type: 'dangerFullAccess' }, { type: 'readOnly', networkAccess: true }]) {
    await t.test(JSON.stringify(sandbox) ?? 'missing', async () => {
      const rpc = new RpcProcess(process.execPath, [
        '-e',
        `
        const send = value => console.log(JSON.stringify(value));
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const r=JSON.parse(line);
          if(r.method==='initialize')send({id:r.id,result:{}});
          if(r.method==='account/read')send({id:r.id,result:{account:{type:'chatgpt'}}});
          if(r.method==='config/read')send({id:r.id,result:{config:{}}});
          if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'read-only'},model:'fixture',approvalPolicy:'untrusted',sandbox:${JSON.stringify(sandbox)}}});
          if(r.method==='mcpServerStatus/list')send({id:r.id,result:{data:[],nextCursor:null}});
        });
      `,
      ]);
      try {
        await assert.rejects(
          connectCodex(
            {
              cwd: tmpdir(),
              providerSessionId: null,
              model: null,
              signal: new AbortController().signal,
              emit: () => {},
            },
            () => rpc,
          ),
          /read-only sandbox/,
        );
      } finally {
        await rpc.close();
      }
    });
  }
});
