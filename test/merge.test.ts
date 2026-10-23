// `grampus merge`: an explicit fast-forward of the repository's checked-out branch to the verified commit.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { mergeAccepted } from '../src/delivery/merge.js';
import { git, headSha } from '../src/git/git.js';
import { foldEvents } from '../src/pipeline/state.js';
import { TaskStore } from '../src/store/task-store.js';
import { commitAll, createRepository, useTestSettings, write } from './helpers/task-fixture.js';

/** A repository with an accepted task: its worktree branch has one verified commit on top of main. */
async function acceptedTask(outcome: 'accepted' | 'abandoned' = 'accepted') {
  useTestSettings();
  const repo = await createRepository();
  const baseSha = await headSha(repo);
  const worktree = `${repo}-task`;
  await git(repo, ['worktree', 'add', '-q', '-b', 'grampus-task-1', worktree]);
  write(worktree, 'greet.js', 'export const greet = name => `Hello, ${name}!`;\n');
  await commitAll(worktree, 'Greet by name');
  const sha = await headSha(worktree);
  const store = TaskStore.create(mkdtempSync(join(tmpdir(), 'grampus-merge-')), 'task-1');
  store.append({
    type: 'task.created',
    taskId: 'task-1',
    title: 'T',
    request: 'R',
    repoPath: repo,
    recipe: standardRecipe,
  });
  store.append({ type: 'workspace.created', worktreeId: 'wt', path: worktree, baseSha, driverTerminal: 'term' });
  store.append({
    type: 'spec.recorded',
    key: 'spec:1',
    version: 1,
    hash: 'hash',
    path: 'spec.md',
    checks: [{ name: 'greet', command: 'node test/greet.test.js' }],
    protected: [],
  });
  store.append({ type: 'checks.recorded', phase: 'verify', round: 0, sha, results: [] });
  store.append({ type: 'task.finished', outcome, sha, override: false, reason: null });
  return { repo, worktree, sha, store };
}

test('merge fast-forwards the checked-out branch to the verified commit and records it', async () => {
  const { repo, sha, store } = await acceptedTask();
  const result = await mergeAccepted(store);
  assert.deepEqual(result, { branch: 'main', sha, alreadyMerged: false });
  assert.equal(await headSha(repo), sha);
  assert.deepEqual(foldEvents(store.events()).merged, { branch: 'main', sha });
  assert.deepEqual(await mergeAccepted(store), { branch: 'main', sha, alreadyMerged: true }, 'a repeat is harmless');
});

test('merge merges the verified commit, not whatever the branch holds later', async () => {
  const { repo, worktree, sha, store } = await acceptedTask();
  write(worktree, 'later.txt', 'unverified\n');
  await commitAll(worktree, 'Unverified change after acceptance');
  await mergeAccepted(store);
  assert.equal(await headSha(repo), sha);
});

test('merge refuses when the target moved, the checkout is dirty, or the task was not accepted', async () => {
  const moved = await acceptedTask();
  write(moved.repo, 'other.txt', 'someone else\n');
  await commitAll(moved.repo, 'Moved on');
  await assert.rejects(mergeAccepted(moved.store), /main has moved on/);

  const dirty = await acceptedTask();
  writeFileSync(join(dirty.repo, 'greet.js'), '// local edit\n');
  await assert.rejects(mergeAccepted(dirty.store), /uncommitted changes/);

  const abandoned = await acceptedTask('abandoned');
  await assert.rejects(mergeAccepted(abandoned.store), /only an accepted task/);
});
