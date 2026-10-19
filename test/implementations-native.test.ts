// Implementation tests: native supervision, editing leases and questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sessions, runSession } from '../src/execution/sessions.js';
import { runCheckProcess } from '../src/process/check-process.js';
import { windows, fixture, fakeResult } from './helpers/implementations.js';

test('native implementation defaults to an unlimited supervised turn', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    assert.equal(options.timeoutMs, 0);
    return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.result?.error ?? run.error ?? '');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('unlimited native supervision completes normally and still supports explicit stop', windows, async () => {
  const completed = await runCheckProcess({
    file: process.execPath,
    args: ['-e', 'setTimeout(()=>console.log("done"),22_000)'],
    cwd: process.cwd(),
    timeoutMs: 0,
    started: () => {},
  });
  assert.equal(completed.reason, 'exited');
  assert.equal(completed.exitConfirmed, true);
  assert.equal(completed.stdout.trim(), 'done');
  const abort = new AbortController();
  const stopped = await runCheckProcess({
    file: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    timeoutMs: 0,
    signal: abort.signal,
    started: kind => {
      if (kind === 'tool') setTimeout(() => abort.abort(), 200);
    },
  });
  assert.equal(stopped.reason, 'interrupted');
  assert.equal(stopped.exitConfirmed, true);
});

test(
  'native fixture editing records before/after content and keeps every completion gate outstanding',
  windows,
  async t => {
    const f = await fixture(t);
    const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      assert.equal(f.store.lease(f.workspace.id)?.kind, 'implementation');
      assert.equal(f.store.implementations(f.execution.id).at(-1)?.dispatch, 'requested');
      writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('hello world');\n");
      return fakeResult(options);
    });
    assert.equal(run.phase, 'completed', run.error ?? undefined);
    assert.notEqual(run.before?.artifact, run.after?.artifact);
    assert.equal(f.workflow.get(f.task.id).phase, 'running');
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal(f.store.lease(f.workspace.id), null);
    await assert.rejects(runSession(f.store, f.execution.sessionId, 'Ordinary conversation'), /execution-implement/);
  },
);

test('out-of-scope writes cannot become a successful implementation reply', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    writeFileSync(join(f.workspace.path, 'other.txt'), 'unauthorized');
    return fakeResult(options);
  });
  assert.equal(run.phase, 'failed');
  assert.match(run.error!, /outside the explicit/);
  assert.equal(f.workflow.get(f.task.id).phase, 'failed');
  assert.equal(readFileSync(join(f.workspace.path, 'other.txt'), 'utf8'), 'unauthorized');
});

test('stale policies refuse dispatch and conversation sessions cannot acquire editing leases', windows, async t => {
  const f = await fixture(t);
  let called = false;
  writeFileSync(join(f.workspace.path, 'other.txt'), 'new content');
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    called = true;
    return fakeResult(options);
  });
  assert.equal(called, false);
  assert.equal(run.dispatch, 'not_requested');
  assert.equal(run.phase, 'failed');
  const g = await fixture(t, 'codex');
  const session = new Sessions(g.store).get(g.execution.sessionId);
  session.providerSessionId = 'conversation-thread';
  g.store.saveSession(session.id, session);
  await assert.rejects(g.implementations.run(g.execution.id, g.policy), /fresh session/);
  assert.equal(g.store.lease(g.workspace.id), null);
  assert.deepEqual(g.store.implementations(g.execution.id), []);
});

test('fresh Codex implementation uses the shared supervised editing lease and settlement', windows, async t => {
  const f = await fixture(t, 'codex');
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
    assert.equal(new Sessions(f.store).get(f.execution.sessionId).mode, 'editing');
    assert.equal(f.store.lease(f.workspace.id)?.kind, 'implementation');
    writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('hello world');\n");
    return fakeResult(options);
  });
  assert.equal(run.phase, 'completed', run.error ?? undefined);
  assert.equal(f.workflow.get(f.task.id).phase, 'running');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('native questions resume only with complete answers and a newly acknowledged policy', windows, async t => {
  const f = await fixture(t);
  await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options =>
    fakeResult(options, {
      kind: 'question',
      text: 'Choose greeting',
      questions: [{ id: 'greeting', prompt: 'Which greeting?', choices: ['hello world'] }],
      findings: [],
    }),
  );
  assert.equal(new Sessions(f.store).get(f.execution.sessionId).phase, 'awaiting_answer');
  await assert.rejects(f.implementations.run(f.execution.id, f.policy), /Answer every pending/);
  const resumed = await f.implementations.run(
    f.execution.id,
    f.policy,
    undefined,
    { answers: { greeting: 'hello world' } },
    async options => {
      const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string };
      assert.match(request.prompt, /hello world/);
      return fakeResult(options);
    },
  );
  assert.equal(resumed.phase, 'completed');
});
