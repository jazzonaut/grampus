// Delivery after acceptance: an explicit, opt-in fast-forward of the repository's checked-out branch to
// the verified commit. It is the only Git write Grampus makes outside a task worktree (where a discarded
// polish pass is reset, see git.ts). It merges the exact SHA that was verified
// and accepted, never later commits on the task branch, and refuses anything but a clean fast-forward.
// It never pushes.
import { git, headSha, isAncestor, uncommittedPaths } from '../git/git.js';
import { foldEvents } from '../pipeline/state.js';
import { finalCandidate } from '../pipeline/candidate.js';
import type { TaskStore } from '../store/task-store.js';

export interface MergeResult {
  branch: string;
  sha: string;
  /** The branch already contained the commit; nothing changed. */
  alreadyMerged: boolean;
}

/** Fast-forward the main checkout's current branch to an accepted task's verified commit. */
export async function mergeAccepted(store: TaskStore): Promise<MergeResult> {
  const state = foldEvents(store.events());
  if (state.finished?.outcome !== 'accepted' || !state.finished.sha)
    throw new Error(`Task ${state.taskId} is not accepted: only an accepted task can be merged.`);
  const sha = state.finished.sha;
  if (finalCandidate(state)?.sha !== sha)
    throw new Error('The accepted commit does not match the recorded final candidate.');
  const repo = state.repoPath;
  const branch = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (!branch) throw new Error(`${repo} has no branch checked out; check out the branch to merge into first.`);
  if (await isAncestor(repo, sha, 'HEAD')) {
    recordMerge(store, state.merged, branch, sha);
    return { branch, sha, alreadyMerged: true };
  }
  const dirty = await uncommittedPaths(repo);
  if (dirty.length)
    throw new Error(`${repo} has uncommitted changes (${dirty.slice(0, 3).join(', ')}); commit or stash them first.`);
  if (!(await isAncestor(repo, 'HEAD', sha)))
    throw new Error(
      `${branch} has moved on since the task started, so the verified commit cannot be fast-forwarded. ` +
        `Merge or rebase branch ${await taskBranch(state.workspace?.path)} yourself.`,
    );
  await git(repo, ['merge', '--ff-only', '--quiet', sha]);
  if ((await headSha(repo)) !== sha) throw new Error(`The merge did not leave ${branch} at ${sha}; inspect ${repo}.`);
  recordMerge(store, state.merged, branch, sha);
  return { branch, sha, alreadyMerged: false };
}

function recordMerge(
  store: TaskStore,
  merged: { branch: string; sha: string } | null,
  branch: string,
  sha: string,
): void {
  if (merged?.branch === branch && merged.sha === sha) return;
  store.append({ type: 'task.merged', branch, sha });
}

async function taskBranch(worktree: string | undefined): Promise<string> {
  if (!worktree) return 'the task branch';
  return (await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'the task branch')).trim();
}
