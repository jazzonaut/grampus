import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Kickoffs } from '../src/kickoff.js';
import { generateTaskTitle, parseTaskTitle } from '../src/task-title.js';
import type { Connector, Reply, TurnResult } from '../src/agents/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const repo = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Offline test'); git('config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(repo, 'hello.js'), "console.log('hello');\n");
  git('add', '.'); git('commit', '-m', 'Baseline');
  const db = join(repo, 'journal.sqlite'), store = new Store(db);
  t.after(() => { store.close(); rmSync(repo, { recursive: true, force: true }); });
  const plan = { brief: { title: 'Planner fallback title', outcome: 'Preserve the greeting', criteria: ['Print hello'], plan: 'Check existing behavior' },
    slices: [{ mode: 'no_change', scope: { files: [] }, validation: { file: 'node', args: ['--check', 'hello.js'] },
      acceptance: { file: 'node', args: ['hello.js'], expectedStdout: 'hello\n' }, message: 'Verify greeting' }] };
  return { repo, db, store, plan };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const message = (text: string): TurnResult => ({ status: 'completed', reply: { kind: 'message', text, questions: [], findings: [] }, usage: null, error: null });
const question: Reply = { kind: 'question', text: 'Confirm the greeting', questions: [{ id: 'greeting', prompt: 'Keep hello?', choices: ['yes'] }], findings: [] };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for naming');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a background task name appears during planning, survives reopening and carries into the task', async t => {
  const f = fixture(t), plannerStarted = deferred(), finishPlanner = deferred(), startNaming = deferred();
  let namingCalls = 0, namingPrompt = '';
  const connector: Connector = async (provider, options) => {
    assert.equal(provider, 'claude');
    if (options.purpose === 'title') {
      namingCalls++; assert.equal(options.providerSessionId, null); assert.equal(options.repository, undefined);
      return { turn: async prompt => { namingPrompt = prompt; await startNaming.promise; return message('Verify the greeting'); }, interrupt: async () => {}, close: async () => {} };
    }
    return { turn: async () => { plannerStarted.resolve(); await finishPlanner.promise; return message(JSON.stringify(f.plan)); }, interrupt: async () => {}, close: async () => {} };
  };
  const planners = new Kickoffs(f.store, connector), request = 'Could you please check that the greeting still works? It should keep printing hello.';
  const id = planners.create({ repo: f.repo, request, provider: 'claude' });
  assert.equal(planners.view(id).title, null); assert.equal(namingCalls, 0);
  const sending = planners.send(id);
  try {
    await plannerStarted.promise;
    const key = planners.view(id).turnKey;
    startNaming.resolve();
    await until(() => planners.view(id).title === 'Verify the greeting');
    assert.equal(planners.view(id).turnKey, key); assert.equal(planners.view(id).session.phase, 'running');
    assert.equal(planners.list().length, 1); assert.equal(f.store.list().length, 0);
    assert.match(namingPrompt, /Could you please check/); assert.doesNotMatch(namingPrompt, /console\.log/);
    const reader = new Store(f.db);
    try {
      const saved = new Kickoffs(reader).view(id);
      assert.equal(saved.title, 'Verify the greeting'); assert.equal(saved.config.request, request);
      assert.deepEqual(saved.messages.map(item => item.text), [request]);
    } finally { reader.close(); }
  } finally { startNaming.resolve(); finishPlanner.resolve(); await sending; }
  const proposed = await sending;
  assert.equal(proposed.error, null); assert.equal(proposed.candidate!.brief.title, 'Verify the greeting');
  const revised = await planners.send(id, 'Keep the same greeting');
  assert.equal(revised.candidate!.brief.title, 'Verify the greeting'); assert.equal(namingCalls, 1);
  const taskId = planners.prepare(id, revised.candidateDigest!);
  assert.equal(f.store.guidedSummaries().find(task => task.id === taskId)?.title, 'Verify the greeting');
});

test('naming failure preserves planning questions and is not retried after restart', async t => {
  const f = fixture(t); let namingCalls = 0;
  const connector: Connector = async (_, options) => {
    if (options.purpose === 'title') { namingCalls++; throw new Error('Naming provider unavailable'); }
    return { turn: async () => ({ ...message(''), reply: question }), interrupt: async () => {}, close: async () => {} };
  };
  const planners = new Kickoffs(f.store, connector), id = planners.create({ repo: f.repo, request: 'Preserve hello' });
  const planned = await planners.send(id);
  assert.equal(planned.title, null); assert.equal(planned.error, null);
  assert.equal(planned.session.phase, 'awaiting_answer'); assert.deepEqual(planned.session.lastReply, question);
  const reopened = new Store(f.db);
  try {
    const continued = await new Kickoffs(reopened, connector).send(id, undefined, { greeting: 'yes' });
    assert.equal(continued.error, null); assert.equal(continued.session.phase, 'awaiting_answer'); assert.equal(namingCalls, 1);
  } finally { reopened.close(); }
});

test('invalid naming output falls back to the plan title and older candidates need no naming call', async t => {
  const f = fixture(t), finishPlanner = deferred(), nameClosed = deferred();
  const connector: Connector = async (_, options) => options.purpose === 'title'
    ? { turn: async () => message('{"title":"Unwanted JSON"}'), interrupt: async () => {}, close: async () => { nameClosed.resolve(); } }
    : { turn: async () => { await finishPlanner.promise; return message(JSON.stringify(f.plan)); }, interrupt: async () => {}, close: async () => {} };
  const planners = new Kickoffs(f.store, connector), id = planners.create({ repo: f.repo, request: 'Check the greeting' });
  const sending = planners.send(id);
  try { await nameClosed.promise; } finally { finishPlanner.resolve(); }
  const planned = await sending;
  assert.equal(planned.title, f.plan.brief.title); assert.equal(planned.error, null);
  // Simulate a saved candidate from before automatic names existed.
  const old = planners.create({ repo: f.repo, request: 'An older conversation' });
  f.store.appendSession(old, 'kickoff.candidate', { plan: planned.candidate });
  let calls = 0;
  await generateTaskTitle(f.store, old, planners.view(old).config, new AbortController().signal, async () => { calls++; throw new Error('Unexpected naming call'); });
  assert.equal(calls, 0); assert.equal(planners.view(old).title, f.plan.brief.title);
});

test('stopping planning cancels its independent naming session without publishing a late title', async t => {
  const f = fixture(t), nameStarted = deferred(), stopped = deferred();
  let interrupts = 0, closes = 0;
  const connector: Connector = async (_, options) => ({
    turn: async () => { if (options.purpose === 'title') nameStarted.resolve(); await stopped.promise; return message('Late generated name'); },
    interrupt: async () => { interrupts++; stopped.resolve(); }, close: async () => { closes++; },
  });
  const planners = new Kickoffs(f.store, connector), id = planners.create({ repo: f.repo, request: 'Check the greeting' }), abort = new AbortController();
  const sending = planners.send(id, undefined, undefined, abort.signal);
  await nameStarted.promise; abort.abort();
  const planned = await sending;
  assert.equal(planned.title, null); assert.equal(planned.session.phase, 'interrupted');
  assert.equal(interrupts, 2); assert.equal(closes, 2);
  assert.equal(f.store.sessionEvents(id).some(event => event.type === 'kickoff.title_generated'), false);
});

test('naming has no automatic deadline and concurrent requests generate at most one name', async t => {
  const f = fixture(t), started = deferred(), stopped = deferred();
  const planners = new Kickoffs(f.store), id = planners.create({ repo: f.repo, request: 'Check the greeting', timeoutMs: 100 });
  const before = planners.view(id); let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connector: Connector = async () => {
    calls++;
    return { turn: async () => { started.resolve(); await stopped.promise; return message('Late task name'); }, interrupt: async () => { stopped.resolve(); }, close: async () => {} };
  };
  const naming = generateTaskTitle(f.store, id, before.config, new AbortController().signal, connector);
  await started.promise;
  await generateTaskTitle(f.store, id, before.config, new AbortController().signal, connector);
  t.mock.timers.tick(600_000);
  assert.equal(planners.view(id).title, null);
  stopped.resolve();
  await naming;
  const after = planners.view(id);
  assert.equal(calls, 1); assert.equal(after.title, 'Late task name'); assert.equal(after.error, null);
  assert.equal(after.session.phase, 'idle'); assert.equal(after.turnKey, before.turnKey);
});

test('task names reject empty, multiline, oversized and structured model responses', () => {
  assert.equal(parseTaskTitle('  Fix NXT-772 login flow  '), 'Fix NXT-772 login flow');
  assert.equal(parseTaskTitle('修复登录流程'), '修复登录流程');
  for (const text of ['', '   ', 'a'.repeat(71), 'Name\nExplanation', '{"title":"Name"}', '<b>Name</b>', '`Name`']) assert.equal(parseTaskTitle(text), null);
});
