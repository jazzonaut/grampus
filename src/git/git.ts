// Git queries against a task worktree. The builder commits and Grampus verifies the commit it finds. The
// only Git writes Grampus makes are the user's explicit `grampus merge` (delivery/merge.ts) and
// `resetWorktree`, which discards a simplify pass that did not hold.
import { currentSettings } from '../config/settings.js';
import type { DiffSize } from '../domain/events.js';
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

/** Lines added and deleted in one changed path; null counts mean Git treats the file as binary. */
export interface LineChange {
  path: string;
  oldPath: string | null;
  added: number | null;
  deleted: number | null;
}

/** Lines added and deleted per path between two commits, with rename detection. */
export async function lineChanges(cwd: string, from: string, to: string): Promise<LineChange[]> {
  const fields = (await git(cwd, ['diff', '--numstat', '-z', '-M', from, to])).split('\0');
  const changes: LineChange[] = [];
  const count = (text: string): number | null => (text === '-' ? null : Number(text));
  for (let index = 0; index < fields.length;) {
    const [added, deleted, path] = (fields[index++] ?? '').split('\t');
    if (added === undefined || deleted === undefined) continue;
    // A rename leaves the path empty and follows with the old and new paths as separate fields.
    if (path === '') {
      const oldPath = fields[index++] ?? '';
      changes.push({ path: fields[index++] ?? '', oldPath, added: count(added), deleted: count(deleted) });
    } else changes.push({ path: path ?? '', oldPath: null, added: count(added), deleted: count(deleted) });
  }
  return changes;
}

/** Files and lines changed between two commits. */
export async function diffSize(cwd: string, from: string, to: string): Promise<DiffSize> {
  const changes = await lineChanges(cwd, from, to);
  return {
    files: changes.length,
    added: changes.reduce((sum, change) => sum + (change.added ?? 0), 0),
    deleted: changes.reduce((sum, change) => sum + (change.deleted ?? 0), 0),
  };
}

/**
 * Move a task worktree back to `sha`, dropping later commits, uncommitted changes and untracked files.
 * Ignored files stay, including the workers' `.grampus/` folder. Only for a task's own worktree.
 */
export async function resetWorktree(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['reset', '--hard', '--quiet', sha]);
  await git(cwd, ['clean', '-fd', '--quiet']);
}

/** The unified diff between two commits, with rename detection. */
export async function patch(cwd: string, from: string, to: string, path?: string): Promise<string> {
  return git(cwd, ['diff', '-M', '--no-color', from, to, ...(path ? ['--', path] : [])]);
}

/** Web URL of origin when it is a GitHub or GitLab remote; unknown hosts stay unknown. */
export async function repositoryWebUrl(cwd: string): Promise<string | null> {
  const remote = await git(cwd, ['remote', 'get-url', 'origin']).catch(() => null);
  if (!remote) return null;
  const value = remote.trim();
  const ssh = /^git@(github\.com|gitlab\.com):(.+?)(?:\.git)?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]?.replace(/\.git$/, '')}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['github.com', 'gitlab.com'].includes(url.hostname)) return null;
    return `https://${url.hostname}${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}
