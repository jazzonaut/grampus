// `grampus wait` through the real CLI: it must not miss a request raised between two calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { TaskStore } from '../src/store/task-store.js';

const cli = join(import.meta.dirname, '..', 'src', 'cli.js');

function grampus(home: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, '--home', home, ...args], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function taskWithRequest(): { home: string; raisedAt: string } {
  const home = mkdtempSync(join(tmpdir(), 'grampus-wait-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ waitTimeoutSeconds: 1, waitPollMs: 50 }));
  const store = TaskStore.create(home, 'task-1');
  store.append({
    type: 'task.created',
    taskId: 'task-1',
    title: 'T',
    request: 'R',
    repoPath: home,
    recipe: standardRecipe,
  });
  const raised = store.append({
    type: 'attention.needed',
    reason: 'approve-spec:1',
    detail: 'Approve spec version 1',
    options: ['approve'],
  });
  return { home, raisedAt: raised.at };
}

test('wait --after returns a request raised after the cursor, even before the wait started', () => {
  const { home, raisedAt } = taskWithRequest();
  const before = new Date(Date.parse(raisedAt) - 1000).toISOString();
  const output = grampus(home, 'wait', '--after', before);
  assert.match(output, /NEEDS YOU: Approve spec version 1/);
  assert.match(output, /as of \d{4}-\d\d-\d\dT/, 'every output carries the cursor for the next wait');
});

test('wait --after the latest cursor waits for something newer', () => {
  const { home } = taskWithRequest();
  const status = grampus(home, 'status');
  const cursor = /as of (\S+)/.exec(status)?.[1];
  assert.ok(cursor, 'status prints a cursor');
  assert.match(grampus(home, 'wait', '--after', cursor), /Nothing new needs you yet/);
});

test('wait reports a task that finished after the cursor', () => {
  const { home } = taskWithRequest();
  const cursor = /as of (\S+)/.exec(grampus(home, 'status'))?.[1] ?? '';
  const store = TaskStore.open(home, 'task-1');
  store.append({ type: 'task.finished', outcome: 'accepted', sha: 'abc123', override: false, reason: null });
  const output = grampus(home, 'wait', '--after', cursor);
  assert.match(output, /accepted/);
  assert.doesNotMatch(output, /Nothing new/);
});

test('the repository defaults to the current directory, resolved from a worktree to its main checkout', async () => {
  const { resolveRepository } = await import('../src/pipeline/create-task.js');
  const { createRepository } = await import('./helpers/task-fixture.js');
  const { git } = await import('../src/git/git.js');
  const repo = await createRepository();
  const worktree = `${repo}-linked`;
  await git(repo, ['worktree', 'add', '-q', '-b', 'linked', worktree]);
  const { realpathSync } = await import('node:fs');
  const same = (a: string, b: string) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  assert.ok(same(await resolveRepository(repo), repo));
  assert.ok(same(await resolveRepository(join(repo, 'test')), repo), 'a subfolder resolves to the repository');
  assert.ok(same(await resolveRepository(worktree), repo), 'a linked worktree resolves to its main checkout');
});
