// Git queries against a task worktree. The builder commits and Grampus verifies the commit it finds; the
// only Git write Grampus makes is the user's explicit `grampus merge` (delivery/merge.ts).
import { currentSettings } from '../config/settings.js';
import { runProcess } from '../process/run.js';

/** Run Git and return stdout, failing on a non-zero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess('git', args, {
    cwd,
    timeoutMs: currentSettings().gitTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.timedOut) throw new Error(`git ${args.join(' ')} timed out in ${cwd}`);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

/** Uncommitted changes, including untracked files that are not ignored. */
export async function uncommittedPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return output
    .split('\0')
    .filter(Boolean)
    .map(entry => entry.slice(3));
}

/** Commits reachable from `to` but not from `from`. */
export async function commitCount(cwd: string, from: string, to: string): Promise<number> {
  return Number((await git(cwd, ['rev-list', '--count', `${from}..${to}`])).trim());
}

/** Whether `ancestor` is reachable from `descendant`, i.e. the branch was not rewritten. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runProcess('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    timeoutMs: currentSettings().gitTimeoutMs,
  });
  return result.exitCode === 0;
}

/** One changed path between two commits. Renames report both paths. */
export interface ChangedPath {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  path: string;
  oldPath: string | null;
}

/** Paths changed between two commits, with rename detection. */
export async function changedPaths(cwd: string, from: string, to: string): Promise<ChangedPath[]> {
  const fields = (await git(cwd, ['diff', '--name-status', '-z', '-M', from, to])).split('\0');
  const changes: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? '';
    if (!code) continue;
    const status = code[0] as ChangedPath['status'];
    if (status === 'R' || status === 'C') {
      const oldPath = fields[index++] ?? '';
      changes.push({ status, path: fields[index++] ?? '', oldPath });
    } else changes.push({ status, path: fields[index++] ?? '', oldPath: null });
  }
  return changes;
}

/** A compact diff summary for prompts, e.g. ` 3 files changed, 40 insertions(+), 2 deletions(-)`. */
export async function diffStat(cwd: string, from: string, to: string): Promise<string> {
  return (await git(cwd, ['diff', '--shortstat', from, to])).trim();
}
