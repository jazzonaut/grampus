// Task title tests: the deterministic provisional title from the request and the plan title that
// replaces it, without any provider call spent on naming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { requestTitle } from '../src/orchestration/task-title.js';
import { serverLimits } from '../src/config/limits.js';
import type { Connector, Reply, TurnResult } from '../src/providers/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const repo = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Offline test');
  git('config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(repo, 'hello.js'), "console.log('hello');\n");
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const db = join(repo, 'grampus.sqlite'),
    store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const plan = {
    brief: {
      title: 'Verify the greeting',
      outcome: 'Preserve the greeting',
      criteria: ['Print hello'],
      plan: 'Check existing behavior',
    },
    slices: [
      {
        mode: 'no_change',
        scope: { files: [] },
        validation: { file: 'node', args: ['--check', 'hello.js'] },
        acceptance: [{ file: 'node', args: ['hello.js'], expectedStdout: 'hello\n' }],
        message: 'Verify greeting',
      },
    ],
  };
  return { repo, db, store, plan };
}

const reply = (value: Reply): TurnResult => ({ status: 'completed', reply: value, usage: null, error: null });
const message = (text: string) => reply({ kind: 'message', text, questions: [], findings: [] });

test('a provisional title is the first sentence of the first line, collapsed, cleaned and bounded', () => {
  assert.equal(
    requestTitle('Could you please check the greeting?  It should keep printing hello.'),
    'Could you please check the greeting',
  );
  assert.equal(requestTitle('\n\n  # Fix   the\tlogin [bug]\nMore detail on the next line.'), 'Fix the login bug');
  assert.equal(requestTitle('- Rename `getUser` to <fetchUser>'), 'Rename getUser to fetchUser');
  assert.equal(
    requestTitle('Version 1.2 of the parser drops -1 offsets'),
    'Version 1.2 of the parser drops -1 offsets',
  );
  assert.equal(requestTitle('\u0007\u0000\n   \n{}[]'), null);
  const long = requestTitle(
    'Replace the hand written retry loop in the delivery worker with the shared bounded backoff helper everywhere',
  )!;
  assert.ok([...long].length <= serverLimits.provisionalTitleCharacters, long);
  assert.match(long, /^Replace the hand written retry loop in the delivery worker\S*…$/);
  assert.doesNotMatch(long, /\s…$/);
  const unbroken = requestTitle('x'.repeat(200))!;
  assert.equal([...unbroken].length, serverLimits.provisionalTitleCharacters);
});

test('planning shows the request title until a plan names the task, with one provider call per turn', async t => {
  const f = fixture(t);
  const replies: TurnResult[] = [
    reply({
      kind: 'question',
      text: 'Confirm the greeting',
      questions: [{ id: 'greeting', prompt: 'Keep hello?', choices: ['yes'] }],
      findings: [],
    }),
    message(JSON.stringify(f.plan)),
    message(JSON.stringify({ ...f.plan, brief: { ...f.plan.brief, title: 'Verify the greeting again' } })),
  ];
  let connections = 0;
  const connector: Connector = async () => {
    connections++;
    return {
      turn: async () => replies.shift()!,
      interrupt: async () => {},
      close: async () => {},
    };
  };
  const planners = new Kickoffs(f.store, connector),
    request = 'Could you please check that the greeting still works? It should keep printing hello.';
  const id = planners.create({ repo: f.repo, request, provider: 'claude' });
  assert.equal(planners.view(id).title, 'Could you please check that the greeting still works');
  const asked = await planners.send(id);
  assert.equal(asked.session.phase, 'awaiting_answer');
  assert.equal(asked.title, 'Could you please check that the greeting still works');
  assert.equal(connections, 1, 'naming spends no provider call');
  const proposed = await planners.send(id, undefined, { greeting: 'yes' });
  assert.equal(proposed.error, null);
  assert.equal(proposed.title, 'Verify the greeting');
  assert.equal(proposed.candidate!.brief.title, 'Verify the greeting');
  const revised = await planners.send(id, 'Keep the same greeting');
  assert.equal(revised.title, 'Verify the greeting again');
  assert.equal(connections, 3);
  assert.ok(
    !f.store.sessionEvents(id).some(event => event.type.startsWith('kickoff.title')),
    'no naming events are journaled',
  );
  const reader = new Store(f.db);
  try {
    assert.equal(new Kickoffs(reader).view(id).title, 'Verify the greeting again');
  } finally {
    reader.close();
  }
  const taskId = planners.prepare(id, revised.candidateDigest!);
  assert.equal(f.store.guidedSummaries().find(task => task.id === taskId)?.title, 'Verify the greeting again');
});
