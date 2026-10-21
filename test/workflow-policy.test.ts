import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFeedback, checkIssue, plainOutput, readCheckLog } from '../src/verification/check-output.js';
import type { RepositoryCheck } from '../src/verification/checks.js';
import { normalizeWorkflowPolicy } from '../src/domain/workflow-policy.js';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { sessionContinuation } from '../src/execution/session-context.js';
import { repositoryTools } from '../src/repository/repository-tools.js';
import type { RepositorySnapshot } from '../src/repository/artifacts.js';
import { agentToolsetVersion } from '../src/providers/types.js';

test('automatic context rotation uses the observed model window while explicit limits remain binding', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const session = new Sessions(store).create('codex', process.cwd());
  session.providerSessionId = 'large-window';
  session.toolsetVersion = agentToolsetVersion;
  store.saveSession(session.id, session);
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 176000, windowTokens: 475000 } });
  assert.equal(sessionContinuation(store, session).resume, true);
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 400000, windowTokens: 475000 } });
  assert.equal(sessionContinuation(store, session).resume, false);
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 176000, windowTokens: 475000 } });
  assert.equal(
    sessionContinuation(store, session, normalizeWorkflowPolicy({ maxContextTokens: 120000 })).resume,
    false,
  );
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 130000, windowTokens: 0 } });
  assert.equal(
    sessionContinuation(store, session).resume,
    false,
    'unknown model windows retain measured input and use the fallback',
  );
});

test('check evidence retains the assertion after noisy output and pages durable Unicode logs beyond the preview', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-log-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output =
    'x'.repeat(65535) + '\x1b[31m\nAssertionError: expected café 🐳 to be tagged\r\n\x1b[0m' + 'tail '.repeat(2000);
  writeFileSync(join(root, 'stderr'), output);
  writeFileSync(join(root, 'stdout'), '');
  const check = {
    id: 'failure',
    spec: { name: 'PDF' },
    phase: 'failed',
    error: null,
    receipt: { directory: root },
    result: {
      stdout: '',
      stderr: output.slice(0, 65536),
      outputTruncated: true,
      reason: 'exited',
      exitCode: 1,
      exitConfirmed: true,
    },
  } as RepositoryCheck;
  assert.match(checkIssue(check), /AssertionError: expected café 🐳/);
  assert.match(checkFeedback(check).issue, /café 🐳/);
  let offset: number | null = 0,
    text = '';
  while (offset !== null) {
    const page = readCheckLog(check, 'stderr', offset, 4096);
    text += page.content;
    offset = page.nextOffset;
    assert.equal(page.incomplete, false);
  }
  assert.equal(text, plainOutput(output));
  assert.doesNotMatch(text, /\ufffd|\[31m/);
  assert.ok(!text.includes('\u001b'), 'no raw escape sequences');
  assert.equal(readCheckLog(check, 'stderr', 65535, 100, true).content, output.slice(65535, 65635));
  assert.throws(() => readCheckLog(check, 'stderr', -1), /Invalid/);
  const emoji = {
    ...check,
    receipt: undefined,
    result: { ...check.result, stderr: 'a🐳b' },
  } as unknown as RepositoryCheck;
  const first = readCheckLog(emoji, 'stderr', 0, 2),
    second = readCheckLog(emoji, 'stderr', first.nextOffset!, 1);
  assert.equal(first.content, 'a');
  assert.equal(second.content, '🐳');
  assert.equal(second.nextOffset, 3);
});

test('a provider conversation no turn ever ran on is started fresh rather than resumed', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const session = new Sessions(store).create('codex', process.cwd());
  // Codex started the thread, then refused the turn's input, so it never saved the conversation.
  session.providerSessionId = 'thread-unsaved';
  session.toolsetVersion = agentToolsetVersion;
  store.saveSession(session.id, session);
  store.appendSession(session.id, 'turn.requested', { runId: 'run' });
  store.appendSession(session.id, 'turn.result', {
    runId: 'run',
    result: { status: 'failed', reply: null, usage: null, error: 'Input exceeds the maximum length' },
    exitConfirmed: true,
  });
  const refused = sessionContinuation(store, session);
  assert.equal(refused.resume, false);
  assert.match(refused.reason, /no turn ran/i);
  // A later session on the same conversation that did complete a turn makes it resumable.
  const peer = new Sessions(store).create('codex', process.cwd());
  peer.providerSessionId = 'thread-unsaved';
  peer.toolsetVersion = agentToolsetVersion;
  store.saveSession(peer.id, peer);
  store.appendSession(peer.id, 'turn.result', {
    runId: 'later',
    result: { status: 'completed', reply: null, usage: null, error: null },
    exitConfirmed: true,
  });
  assert.equal(sessionContinuation(store, session).resume, true);
});

test('context rotation uses current input size, retains warm conversations and falls back to a turn limit', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const session = new Sessions(store).create('codex', process.cwd());
  session.providerSessionId = 'thread-a';
  session.toolsetVersion = agentToolsetVersion;
  store.saveSession(session.id, session);
  store.appendSession(session.id, 'turn.requested', {});
  store.appendSession(session.id, 'usage.updated', { data: { inputTokens: 5000000 } });
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 2000 } });
  const policy = normalizeWorkflowPolicy({ maxSessionTurns: 2, maxContextTokens: 10000 });
  assert.equal(sessionContinuation(store, session, policy).resume, true);
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 11000 } });
  assert.equal(sessionContinuation(store, session, policy).resume, false);
  store.appendSession(session.id, 'context.updated', { data: { inputTokens: 3000 } });
  store.appendSession(session.id, 'turn.requested', {});
  assert.match(sessionContinuation(store, session, policy).reason, /2 turns/);
  session.toolsetVersion = 0;
  assert.match(sessionContinuation(store, session, policy).reason, /current evidence/);
  for (const input of [
    { maxContextTokens: 1 },
    { maxSessionTurns: 0 },
    { repairRounds: 11 },
    { mode: 'anything' },
    { mystery: true },
  ])
    assert.throws(() => normalizeWorkflowPolicy(input));
});

test('agents can page only supplied check evidence and inspect installed dependency source without wider file access', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-dependency-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules', 'fixture-package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'fixture-package', version: '1.2.3', main: 'index.js' }),
  );
  writeFileSync(join(pkg, 'index.js'), 'exports.tagged = true;');
  const check = {
    id: 'owned',
    spec: { name: 'Check' },
    phase: 'failed',
    result: { stdout: '0123456789', stderr: '\x1b[31mActual error\x1b[0m' },
  } as RepositoryCheck;
  const events: unknown[] = [],
    snapshot = { artifact: 'sha256:fixture', files: [] } as unknown as RepositorySnapshot;
  const invoke = repositoryTools(
    { repo: root, snapshot, checks: [check] },
    event => events.push(event),
    () => true,
  );
  assert.match((invoke('grampus_read_check', { checkId: 'owned' }) as any).content, /^Actual error$/);
  assert.equal(
    (invoke('grampus_read_check', { checkId: 'owned', stream: 'stdout', offset: 3, limit: 2 }) as any).nextOffset,
    5,
  );
  assert.throws(() => invoke('grampus_read_check', { checkId: 'another-task' }), /absent/);
  const source = invoke('grampus_read_dependency', { package: 'fixture-package', path: 'index.js', limit: 7 }) as any;
  assert.equal(source.content, 'exports');
  assert.equal(source.nextOffset, 7);
  assert.equal(source.version, '1.2.3');
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  const found = invoke('grampus_read_dependency', {
    package: 'fixture-package',
    path: 'index.js',
    query: 'tagged',
  }) as any;
  assert.equal(found.matches.length, 1);
  assert.match(found.matches[0].content, /tagged = true/);
  assert.equal(found.nextOffset, null);
  for (const input of [
    { package: 'fixture-package', path: '../../outside' },
    { package: '../outside' },
    { package: 'fixture-package', from: '..' },
    { package: 'fixture-package', path: '.npmrc' },
  ])
    assert.throws(() => invoke('grampus_read_dependency', input));
  assert.ok(events.length >= 3);
});
