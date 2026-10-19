// Boundary schema tests: journal records, supervisor output and receipts, worker request files, Orca and
// Git output, agent tool arguments and replies, and CLI input files. Each covers a realistic value, an
// unexpected extra field and a malformed value, which must be a categorised error rather than a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { RecordNotFoundError } from '../src/persistence/errors.js';
import { BoundaryError, boundedExcerpt, describeIssues } from '../src/process/boundary.js';
import { completionReceiptSchema, supervisorMessageSchema } from '../src/process/supervisor-protocol.js';
import { readReceipt } from '../src/verification/check-recovery.js';
import { readDeliveryRequest, readImplementationResult } from '../src/execution/worker-files.js';
import { OrcaCli } from '../src/repository/orca.js';
import { indexEntry, lsTreeLongEntry, worktreeList } from '../src/repository/git-output.js';
import { parseExplorationCall } from '../src/repository/repository-tool-arguments.js';
import { parseReply } from '../src/providers/types.js';
import { replyOutputSchema } from '../src/providers/reply-schema.js';
import { answersFile, checkSpecFile } from '../src/cli-input.js';
import type { Session } from '../src/persistence/records.js';

function directory(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'grampus-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const session: Session = {
  id: 'session-1',
  provider: 'codex',
  providerSessionId: null,
  model: null,
  cwd: process.cwd(),
  phase: 'idle',
  lastReply: null,
  run: null,
};
const snapshot = {
  artifact: `sha256:${'a'.repeat(64)}`,
  head: 'b'.repeat(40),
  index: '',
  files: [{ path: 'a.txt', sha256: 'c'.repeat(64), executable: false }],
  diff: [],
  instructions: [],
  instructionsDigest: 'd'.repeat(64),
};

test('journal records are validated on read, returned in their stored key order, and refused when malformed', t => {
  const path = join(directory(t), 'grampus.sqlite');
  const store = new Store(path);
  try {
    // Stored with a key order unlike the schema and an extra field: both survive the validated read.
    const stored = {
      run: null,
      lastReply: null,
      phase: 'idle',
      cwd: process.cwd(),
      model: null,
      providerSessionId: null,
      provider: 'claude',
      id: 'ordered',
      note: 'extra',
    };
    const db = new DatabaseSync(path);
    try {
      db.prepare('INSERT INTO sessions(id, state) VALUES (?, ?)').run('ordered', JSON.stringify(stored));
      db.prepare('INSERT INTO sessions(id, state) VALUES (?, ?)').run(
        'broken',
        JSON.stringify({ ...session, id: 'broken', phase: 'dancing' }),
      );
      db.prepare('INSERT INTO sessions(id, state) VALUES (?, ?)').run('garbled', '{not json');
    } finally {
      db.close();
    }
    assert.equal(JSON.stringify(store.session('ordered')), JSON.stringify(stored));
    assert.throws(
      () => store.session('broken'),
      (error: unknown) =>
        error instanceof BoundaryError &&
        error.kind === 'journal-record' &&
        error.source === 'sessions' &&
        error.issues.some(issue => issue.startsWith('phase')),
    );
    assert.throws(
      () => store.session('garbled'),
      (error: unknown) => error instanceof BoundaryError && error.kind === 'journal-record',
    );
    assert.throws(
      () => store.session('missing'),
      (error: unknown) => error instanceof RecordNotFoundError && error.record === 'Session',
    );
    assert.throws(() => store.sessions(), BoundaryError);
  } finally {
    store.close();
  }
});

test('supervisor messages and completion receipts are pinned; extra fields pass, other shapes do not', t => {
  assert.deepEqual(supervisorMessageSchema.parse({ type: 'started', pid: 4321, at: 'extra' }), {
    type: 'started',
    pid: 4321,
  });
  assert.equal(supervisorMessageSchema.safeParse({ type: 'progress', pid: 1 }).success, false);
  assert.equal(supervisorMessageSchema.safeParse({ type: 'started', pid: 0 }).success, false);
  const receipt = {
    protocol: 1,
    checkId: 'check',
    token: 'token',
    supervisorPid: 2 ** 31,
    supervisorStartedAt: '133000000000000000',
    toolPid: 0,
    reason: 'timed_out',
    exitCode: 1,
    exitConfirmed: true,
    future: 'field',
  };
  assert.equal(completionReceiptSchema.parse(receipt).reason, 'timed_out');
  assert.equal(completionReceiptSchema.safeParse({ ...receipt, reason: 'crashed' }).success, false);
  const root = directory(t);
  writeFileSync(join(root, 'completion.json'), '{"protocol":1,');
  assert.throws(
    () => readReceipt({ directory: root, token: 'token', checkId: 'check' }, null, null),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'supervisor-receipt',
  );
});

test('worker files are validated before use and keep their bytes for fencing', t => {
  const root = directory(t);
  const request = {
    snapshot,
    message: 'Deliver',
    base: 'main',
    branch: 'refs/heads/grampus/task',
    cwd: root,
    id: 'delivery-1',
  };
  writeFileSync(join(root, 'delivery.json'), JSON.stringify(request));
  assert.equal(JSON.stringify(readDeliveryRequest(join(root, 'delivery.json'))), JSON.stringify(request));
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ ...request, snapshot: { ...snapshot, files: 'all' } }));
  assert.throws(
    () => readDeliveryRequest(join(root, 'bad.json')),
    (error: unknown) =>
      error instanceof BoundaryError && error.kind === 'worker-request' && /snapshot\.files/.test(error.message),
  );
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      id: 'run',
      result: {
        status: 'completed',
        reply: { kind: 'question', text: 'x', questions: [], findings: [] },
        usage: null,
        error: null,
      },
    }),
  );
  assert.throws(() => readImplementationResult(join(root, 'result.json')), BoundaryError);
});

const local = {
  id: 'repo-1::wt',
  repoId: 'repo-1',
  path: process.platform === 'win32' ? 'C:\\work\\wt' : '/work/wt',
  branch: 'refs/heads/wt',
  displayName: 'wt',
  hostId: 'local',
  instanceId: 'instance-1',
  identity: { executionHostId: 'local', instanceId: 'instance-1', key: 'wt2:local:instance-1', extra: true },
  isMainWorktree: false,
  isArchived: false,
  comment: 'marker',
  futureField: { nested: true },
};

test('Orca output tolerates additive fields and names the command when its shape changes', async () => {
  const shown = await new OrcaCli(async () => JSON.stringify({ ok: true, result: { worktree: local }, meta: 1 })).show(
    '.',
    'key',
  );
  assert.equal(shown.identityKey, 'wt2:local:instance-1');
  await assert.rejects(
    new OrcaCli(async () => JSON.stringify({ ok: true, result: { worktree: { ...local, isArchived: 'no' } } })).show(
      '.',
      'key',
    ),
    (error: unknown) =>
      error instanceof BoundaryError && error.kind === 'orca-output' && error.source === 'worktree show',
  );
  await assert.rejects(
    new OrcaCli(async () => '{bad json').show('.', 'key'),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'orca-output',
  );
});

test('Git plumbing lines are parsed field by field and refused when they do not match', () => {
  assert.deepEqual(lsTreeLongEntry(`100644 blob ${'a'.repeat(40)}     123\tdir/file name.txt`), {
    mode: '100644',
    type: 'blob',
    oid: 'a'.repeat(40),
    size: 123,
    path: 'dir/file name.txt',
  });
  assert.equal(indexEntry(`100755 ${'b'.repeat(40)} 0\tbin/run`).mode, '100755');
  assert.throws(
    () => indexEntry('garbage'),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'git-output',
  );
  assert.deepEqual(worktreeList('worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /other\0detached\0\0'), [
    { worktree: '/repo', HEAD: 'abc', branch: 'refs/heads/main' },
    { worktree: '/other' },
  ]);
  assert.throws(() => worktreeList('HEAD abc\0\0'), BoundaryError);
});

test('agent tool arguments are strict, typed and refused with the message returned to the agent', () => {
  assert.deepEqual(parseExplorationCall('grampus_read_file', { path: 'a.txt', limit: 5 }), {
    tool: 'grampus_read_file',
    args: { path: 'a.txt', limit: 5 },
  });
  assert.throws(
    () => parseExplorationCall('grampus_list_files', { query: 'x', shell: 'rm' }),
    /Unknown repository tool argument/,
  );
  assert.throws(() => parseExplorationCall('grampus_list_files', { offset: -1 }), /offset or limit/);
  assert.throws(() => parseExplorationCall('grampus_search', { query: 'a\u0007' }), /text/);
  assert.throws(() => parseExplorationCall('grampus_write_file', {}), /Invalid repository tool/);
});

test('structured replies drop unknown fields, keep exact rules and categorise failures', () => {
  const reply = parseReply({ kind: 'message', text: 'ok', questions: [], findings: [], confidence: 0.9 });
  assert.deepEqual(reply, { kind: 'message', text: 'ok', questions: [], findings: [] });
  assert.throws(
    () =>
      parseReply({
        kind: 'review',
        text: 'x',
        questions: [],
        findings: [{ severity: 'major', description: 'd', evidence: 'e' }],
      }),
    (error: unknown) =>
      error instanceof BoundaryError && error.kind === 'agent-reply' && /Invalid review findings/.test(error.message),
  );
  assert.throws(
    () => parseReply('{"kind":'),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'agent-reply',
  );
  // The schema sent to providers and the schema enforced on replies describe the same fields.
  assert.deepEqual(Object.keys(replyOutputSchema.properties).sort(), [
    'findings',
    'kind',
    'questions',
    'simplification',
    'text',
  ]);
});

test('CLI input files are parsed into typed values with field-level errors', t => {
  const root = directory(t);
  writeFileSync(join(root, 'answers.json'), JSON.stringify({ scope: 'Only the parser', count: 3 }));
  assert.throws(
    () => answersFile(join(root, 'answers.json')),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'cli-input' && /count/.test(error.message),
  );
  writeFileSync(
    join(root, 'check.json'),
    JSON.stringify({
      name: 'test',
      file: 'node',
      args: [],
      timeoutMs: 1000,
      artifact: 'a',
      instructionsDigest: 'b',
      shell: true,
    }),
  );
  assert.throws(() => checkSpecFile(join(root, 'check.json')), /shell/);
});

test('excerpts and issue lists are bounded and never echo values', () => {
  const issues = describeIssues(
    (() => {
      const result = completionReceiptSchema.safeParse({ token: 'secret-token-value' });
      if (result.success) throw new Error('expected failure');
      return result.error;
    })(),
    3,
  );
  assert.equal(issues.length, 4);
  assert.doesNotMatch(issues.join(' '), /secret-token-value/);
  assert.equal(boundedExcerpt(undefined), '"[undefined]"');
  assert.match(boundedExcerpt({ password: 'hunter2', note: 'ok' }), /"password":"\[redacted\]"/);
});
