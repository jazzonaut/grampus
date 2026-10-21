// Native connections keep full workspace permissions while selected references remain pinned read-only reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectCodex } from '../src/providers/codex.js';
import { RpcProcess } from '../src/process/process.js';
import { inspectReference } from '../src/repository/reference-folders.js';
import { snapshotRepository } from '../src/repository/artifacts.js';
import { fixture } from './helpers/guided-tasks.js';

test('native Codex tools can read an approved reference commit rather than dirty checkout bytes', async t => {
  const f = fixture(t);
  const reference = inspectReference(f.repo);
  writeFileSync(join(f.repo, 'greeting.js'), 'dirty reference checkout\n');
  const snapshot = await snapshotRepository(f.repo, 'HEAD');
  const rpc = new RpcProcess(process.execPath, [
    '-e',
    `
    const send=value=>console.log(JSON.stringify(value));
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);
      if(r.method==='initialize')send({id:r.id,result:{}});
      if(r.method==='account/read')send({id:r.id,result:{account:{type:'chatgpt'}}});
      if(r.method==='config/read')send({id:r.id,result:{config:{}}});
      if(r.method==='thread/start'){
        if(r.params.approvalPolicy!=='never'||r.params.sandbox!=='danger-full-access')process.exit(2);
        if(!r.params.developerInstructions.includes('reference-1'))process.exit(3);
        if(!r.params.dynamicTools.some(tool=>tool.name==='grampus_read_file'))process.exit(4);
        send({id:r.id,result:{thread:{id:'native'},model:'fixture',approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});
      }
      if(r.method==='mcpServerStatus/list')send({id:r.id,result:{data:[],nextCursor:null}});
      if(r.method==='turn/start'){
        send({method:'turn/started',params:{threadId:'native',turn:{id:'turn'}}});
        send({id:r.id,result:{turn:{id:'turn'}}});
        send({id:'reference',method:'item/tool/call',params:{threadId:'native',turnId:'turn',callId:'reference',tool:'grampus_read_file',arguments:{root:'reference-1',path:'greeting.js'}}});
      }
      if(r.id==='reference'){
        if(!r.result.success||!r.result.contentItems[0].text.includes("console.log('hello');"))process.exit(5);
        send({method:'item/completed',params:{threadId:'native',turnId:'turn',item:{type:'agentMessage',text:JSON.stringify({kind:'candidate',text:'Read the pinned reference.',questions:[],findings:[]})}}});
        send({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});
      }
    });
  `,
  ]);
  t.after(() => rpc.close());
  const agent = await connectCodex(
    {
      cwd: f.repo,
      providerSessionId: null,
      model: null,
      signal: new AbortController().signal,
      emit: () => {},
      editing: {
        cwd: f.repo,
        snapshot,
        policy: {
          workspace: true,
          files: [],
          artifact: snapshot.artifact,
          instructionsDigest: snapshot.instructionsDigest,
        },
      },
      repository: { repo: f.repo, snapshot, references: [reference] },
    },
    () => rpc,
  );
  t.after(() => agent.close());
  const result = await agent.turn('Use the selected reference.');
  assert.equal(result.status, 'completed', result.error ?? undefined);
  assert.equal(result.reply?.kind, 'candidate');
});
