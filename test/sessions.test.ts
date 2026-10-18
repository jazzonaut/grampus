import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { currentProcessStartedAt } from '../src/process-identity.js';
import { Sessions, runSession } from '../src/sessions.js';
import { parseReply, subscriptionEnvironment, type Connector, type Reply, type TurnResult } from '../src/agents/types.js';
import { hasClaudeSubscription } from '../src/agents/claude.js';

const message: Reply = { kind: 'message', text: 'hello', questions: [], findings: [] };
const question: Reply = { kind: 'question', text: 'Choose a label', questions: [{ id: 'label', prompt: 'Label?', choices: [] }], findings: [] };
function result(reply: Reply = message): TurnResult { return { status: 'completed', reply, usage: null, error: null }; }

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'grampus-session-test-'));
  const store = new Store(join(directory, 'journal.sqlite'));
  const sessions = new Sessions(store);
  const session = sessions.create('codex', directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, sessions, session };
}

test('questions and answers survive reopening; reconnect receives the exact provider session id', async t => {
  const { store, sessions, session, directory } = fixture(t);
  const prompts: string[] = [];
  let count = 0;
  const connect: Connector = async (_, options) => {
    assert.equal(options.providerSessionId, count++ === 0 ? null : 'provider-session');
    options.emit({ type: 'session.connected', data: { providerSessionId: 'provider-session', model: 'observed-model' } });
    return { turn: async prompt => { prompts.push(prompt); return result(prompts.length === 1 ? question : message); }, interrupt: async () => {}, close: async () => {} };
  };
  await runSession(store, session.id, 'Ask me', {}, connect);
  assert.equal(sessions.get(session.id).phase, 'awaiting_answer');
  const reopened = new Store(join(directory, 'journal.sqlite'));
  try {
    await assert.rejects(runSession(reopened, session.id, 'Skip question', {}, connect), /Answer every/);
    await runSession(reopened, session.id, '', { answers: { label: 'reef' } }, connect);
  } finally { reopened.close(); }
  assert.equal(sessions.get(session.id).phase, 'idle');
  assert.match(prompts[1]!, /reef/);
  assert.equal(sessions.get(session.id).model, 'observed-model');
  assert.ok(store.sessionEvents(session.id).some(e => e.type === 'questions.answered'));
});

test('answer turns retain controller instructions alongside validated user answers', t => {
  const { store, sessions, session } = fixture(t);
  const first = sessions.claim(session.id, 'Ask for the label');
  sessions.settle(session.id, first.runId, result(question), true);
  assert.throws(() => sessions.claim(session.id, 'Current controller instructions', { wrong: 'reef' }), /Answer every/);
  const answered = sessions.claim(session.id, 'Current controller instructions', { label: 'reef' });
  assert.equal(answered.prompt, 'Current controller instructions\n\nUser answers to the pending questions:\n{"label":"reef"}');
  assert.equal((store.sessionEvents(session.id).findLast(event => event.type === 'turn.requested')!.data as { prompt: string }).prompt, answered.prompt);
});

test('one controller owns a session and stale results cannot settle a later turn', t => {
  const { sessions, session } = fixture(t);
  const claim = sessions.claim(session.id, 'First');
  assert.throws(() => sessions.claim(session.id, 'Duplicate'), /already owned/);
  sessions.settle(session.id, claim.runId, result(), true);
  const next = sessions.claim(session.id, 'Second');
  sessions.settle(session.id, claim.runId, result(question), true);
  assert.equal(sessions.get(session.id).run?.id, next.runId);
  assert.equal(sessions.get(session.id).phase, 'running');
});

test('interrupt request is persisted before provider interruption; late success cannot become success', async t => {
  const { store, sessions, session } = fixture(t);
  const abort = new AbortController();
  let finish!: (value: TurnResult) => void;
  let closed = false;
  const connect: Connector = async (_, options) => ({
    turn: async () => {
      options.emit({ type: 'turn.started', data: {} });
      const pending = new Promise<TurnResult>(resolve => { finish = resolve; });
      queueMicrotask(() => abort.abort());
      return pending;
    },
    interrupt: async () => {
      assert.equal(sessions.get(session.id).phase, 'stop_requested');
      finish(result());
    },
    close: async () => { closed = true; },
  });
  const output = await runSession(store, session.id, 'Long turn', { signal: abort.signal }, connect);
  assert.equal(output.status, 'interrupted');
  assert.equal(output.reply, null);
  assert.equal(closed, true);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
  assert.ok(store.sessionEvents(session.id).some(e => e.type === 'process.exit_confirmed'));
});

test('unconfirmed child shutdown requires recovery and blocks subsequent work', async t => {
  const { store, sessions, session } = fixture(t);
  const connect: Connector = async (_, options) => {
    options.emit({ type: 'process.started', data: { pid: 12345 } });
    return { turn: async () => result(), interrupt: async () => {}, close: async () => { throw new Error('Still alive'); } };
  };
  const output = await runSession(store, session.id, 'Hello', {}, connect);
  assert.equal(output.status, 'failed');
  assert.equal(sessions.get(session.id).phase, 'recovery_required');
  assert.throws(() => sessions.claim(session.id, 'Again'), /needs recovery/);
  assert.throws(() => sessions.recover(session.id, () => true), /controller is still alive/);
  assert.throws(() => sessions.recover(session.id, pid => pid === 12345), /Provider exit is unconfirmed/);
  sessions.recover(session.id, () => false);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
});

test('a durable pre-connection boundary recovers without inventing provider shutdown', t => {
  const { store, sessions, session } = fixture(t);
  const claim = sessions.claim(session.id, 'Not dispatched', undefined, false, true);
  assert.equal(sessions.get(session.id).run!.providerDispatch, 'not_requested');
  sessions.recover(session.id, () => false);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
  assert.match(JSON.stringify(store.sessionEvents(session.id)), /connection was never requested/);
  const next = sessions.claim(session.id, 'Dispatch requested', undefined, false, true);
  sessions.requestConnection(session.id, next.runId);
  assert.throws(() => sessions.recover(session.id, () => false), /Provider exit is unconfirmed/);
  assert.throws(() => sessions.requestConnection(session.id, claim.runId), /ownership changed/);
});

test('conversation recovery compares original Windows process identities rather than recycled PIDs', { skip: process.platform !== 'win32' }, t => {
  const { store, sessions, session } = fixture(t);
  const claim = sessions.claim(session.id, 'Fixture process identity');
  sessions.event(session.id, claim.runId, { type: 'process.started', data: { pid: process.pid } });
  assert.throws(() => sessions.recover(session.id), /controller is still alive/);
  const saved = sessions.get(session.id), old = (BigInt(currentProcessStartedAt()!) - 1n).toString();
  saved.run!.controllerStartedAt = old; saved.run!.providerStartedAt = old;
  store.saveSession(session.id, saved);
  sessions.recover(session.id);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
});

test('unknown provider liveness cannot be cleared by a recovery guess', t => {
  const { sessions, session } = fixture(t);
  sessions.claim(session.id, 'Starting');
  assert.throws(() => sessions.recover(session.id, () => false), /Provider exit is unconfirmed/);
});

test('a crashed controller is recoverable after both recorded processes have exited', t => {
  const { directory, store, session, sessions } = fixture(t);
  const script = `
    import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    import { Sessions } from ${JSON.stringify(new URL('../src/sessions.js', import.meta.url).href)};
    import { spawn } from 'node:child_process';
    const store = new Store(process.argv[1]);
    const sessions = new Sessions(store);
    const claim = sessions.claim(process.argv[2], 'Interrupted fixture');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    sessions.event(process.argv[2], claim.runId, { type: 'process.started', data: { pid: child.pid } });
    await new Promise(resolve => child.once('close', resolve));
    process.exit(17);
  `;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, join(directory, 'journal.sqlite'), session.id], { stdio: 'pipe' }));
  assert.equal(sessions.get(session.id).phase, 'running');
  sessions.recover(session.id);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
  assert.ok(store.sessionEvents(session.id).some(e => e.type === 'session.recovered'));
});

test('a deadline interrupts the owned turn and never retries inference', async t => {
  const { store, sessions, session } = fixture(t);
  let finish!: (result: TurnResult) => void;
  let count = 0;
  const connect: Connector = async () => ({
    turn: async () => { count++; return new Promise(resolve => { finish = resolve; }); },
    interrupt: async () => finish({ status: 'interrupted', reply: null, usage: null, error: null }),
    close: async () => {},
  });
  assert.equal((await runSession(store, session.id, 'Slow', { timeoutMs: 100 }, connect)).status, 'interrupted');
  assert.equal(count, 1);
  assert.equal(sessions.get(session.id).phase, 'interrupted');
});

test('provider errors are retained without an automatic inference retry', async t => {
  const { store, sessions, session } = fixture(t);
  let starts = 0;
  const connect: Connector = async () => ({
    turn: async () => { starts++; throw new Error('Provider disconnected mid-turn'); },
    interrupt: async () => {}, close: async () => {},
  });
  const output = await runSession(store, session.id, 'Hello', {}, connect);
  assert.equal(starts, 1);
  assert.equal(output.status, 'failed');
  assert.equal(sessions.get(session.id).phase, 'failed');
  assert.match(JSON.stringify(store.sessionEvents(session.id)), /disconnected mid-turn/);
});

test('subscription authentication failure ends before any turn is sent', async t => {
  const { store, sessions, session } = fixture(t);
  const connect: Connector = async () => { throw new Error('Subscription login required'); };
  const output = await runSession(store, session.id, 'Hello', {}, connect);
  assert.equal(output.status, 'failed');
  assert.equal(sessions.get(session.id).phase, 'failed');
  assert.ok(!store.sessionEvents(session.id).some(e => e.type === 'turn.started'));
});

test('an aborted connection is shut down before the session can be reused', async t => {
  const { store, sessions, session } = fixture(t);
  const abort = new AbortController();
  const connect: Connector = async (_, options) => {
    options.emit({ type: 'process.started', data: { pid: 12345 } });
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        options.emit({ type: 'process.exit_confirmed', data: {} });
        reject(new Error('Startup aborted'));
      });
      queueMicrotask(() => abort.abort());
    });
  };
  const output = await runSession(store, session.id, 'Hello', { signal: abort.signal }, connect);
  assert.equal(output.status, 'interrupted');
  assert.equal(sessions.get(session.id).phase, 'interrupted');
});

test('structured replies reject malformed questions and unsupported review conclusions', () => {
  assert.throws(() => parseReply({ ...message, kind: 'question' }), /kind/);
  assert.throws(() => parseReply({ ...question, questions: [...question.questions, ...question.questions] }), /questions/);
  assert.throws(() => parseReply({ ...message, kind: 'review', findings: [{ severity: 'blocking', description: 'Bad', evidence: '' }] }), /findings/);
  assert.throws(() => parseReply('not json'));
  assert.deepEqual(parseReply(JSON.stringify(question)), question);
});

test('API billing environment variables are removed without changing the host environment', () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-not-a-real-key';
  try {
    assert.equal(subscriptionEnvironment().ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-not-a-real-key');
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('Claude Team metadata without tokenSource is accepted; API and gateway accounts are not', () => {
  assert.equal(hasClaudeSubscription({ apiProvider: 'firstParty', subscriptionType: 'Claude Team' }), true);
  assert.equal(hasClaudeSubscription({ apiProvider: 'firstParty', subscriptionType: 'max', tokenSource: 'claude.ai', apiKeySource: 'none' }), true);
  assert.equal(hasClaudeSubscription({ apiProvider: 'firstParty', subscriptionType: 'Claude Team', apiKeySource: 'ANTHROPIC_API_KEY' }), false);
  assert.equal(hasClaudeSubscription({ apiProvider: 'gateway', subscriptionType: 'Claude Team' }), false);
  assert.equal(hasClaudeSubscription({ apiProvider: 'firstParty' }), false);
});

test('schema 1 journals migrate without losing existing task history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'grampus-migration-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    INSERT INTO tasks VALUES ('old', '{"title":"preserved"}');
    INSERT INTO events(task_id,version,at,type,data) VALUES ('old',1,'then','task.created','{}');
    PRAGMA user_version = 1;`);
  old.close();
  const store = new Store(path);
  try {
    assert.deepEqual(store.get('old'), { title: 'preserved' });
    assert.equal(store.events('old').length, 1);
    assert.equal(new Sessions(store).create('claude', directory).phase, 'idle');
  } finally { store.close(); }
});
