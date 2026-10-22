// The cross-check of a full-mode comparison. Each recipe wrote its own spec, so each result passed its own
// checks; a lax spec makes that easy. Here every entry's checks run against every other entry's result,
// with the spec owner's acceptance tests overlaid on the candidate's commit, so all results are judged on
// the same bars. The overlay is temporary: the candidate's worktree is restored and must end clean.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runChecks } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import { changedPaths, git, headSha, uncommittedPaths } from '../git/git.js';
import type { TaskState } from '../pipeline/state.js';
import { matchesAny } from '../util/glob.js';
import type { ComparisonStore, CrossCheckCell } from './comparison.js';

/** An entry's final candidate: the commit its last verified round checked, and the checks of its spec. */
function candidateOf(state: TaskState): { sha: string; round: number } | null {
  const rounds = [...state.verify.keys()];
  if (!rounds.length) return null;
  const round = Math.max(...rounds);
  const sha = state.verify.get(round)?.sha;
  return sha ? { sha, round } : null;
}

/** Run every entry's checks against every entry's candidate. Entries without a candidate give error cells. */
export async function crossCheck(
  store: ComparisonStore,
  entries: readonly TaskState[],
  baseSha: string,
  log: (line: string) => void,
): Promise<CrossCheckCell[]> {
  const cells: CrossCheckCell[] = [];
  for (const owner of entries)
    for (const candidate of entries) cells.push(await cell(store, owner, candidate, baseSha, log));
  return cells;
}

async function cell(
  store: ComparisonStore,
  owner: TaskState,
  candidate: TaskState,
  baseSha: string,
  log: (line: string) => void,
): Promise<CrossCheckCell> {
  const base = { specOf: owner.taskId, candidate: candidate.taskId };
  const target = candidateOf(candidate);
  const spec = owner.specs.at(-1);
  const ownerCandidate = candidateOf(owner);
  if (!target) return { ...base, sha: null, results: null, error: `${candidate.taskId} has no verified commit` };
  if (!spec || !ownerCandidate)
    return { ...base, sha: target.sha, results: null, error: `${owner.taskId} has no approved spec and commit` };
  // An entry against its own spec is its own last verification; running it again would only add noise.
  if (owner.taskId === candidate.taskId)
    return { ...base, sha: target.sha, results: candidate.verify.get(target.round)?.results ?? null, error: null };
  const worktree = candidate.workspace?.path;
  if (!worktree || !existsSync(worktree)) return { ...base, sha: target.sha, results: null, error: 'worktree is gone' };
  try {
    if ((await headSha(worktree)) !== target.sha) throw new Error('worktree moved past the verified commit');
    if ((await uncommittedPaths(worktree)).length) throw new Error('worktree has uncommitted changes');
    log(`Cross-check: ${owner.taskId}'s checks on ${candidate.taskId}.`);
    const results = await withOverlay(worktree, target.sha, baseSha, ownerCandidate.sha, () =>
      runChecks(worktree, spec.checks, store.crossCheckDir(owner.taskId, candidate.taskId), { rerunFailures: true }),
    );
    return { ...base, sha: target.sha, results, error: null };
  } catch (error) {
    return { ...base, sha: target.sha, results: null, error: (error as Error).message };
  }
}

/**
 * Put the owner's added and changed test files into the candidate's worktree, run `work`, then restore the
 * candidate's own files and refuse to finish unless the worktree is clean again.
 */
async function withOverlay<T>(
  worktree: string,
  candidateSha: string,
  baseSha: string,
  ownerSha: string,
  work: () => Promise<T>,
): Promise<T> {
  const patterns = currentSettings().testFilePatterns;
  const tests = (await changedPaths(worktree, baseSha, ownerSha)).filter(
    change => change.status !== 'D' && matchesAny(change.path, patterns),
  );
  const existing = new Set(
    (await git(worktree, ['ls-tree', '-r', '--name-only', '-z', candidateSha])).split('\0').filter(Boolean),
  );
  let outcome: { value: T } | { error: unknown };
  try {
    for (const test of tests) {
      const full = join(worktree, test.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, await git(worktree, ['show', `${ownerSha}:${test.path}`]));
    }
    outcome = { value: await work() };
  } catch (error) {
    outcome = { error };
  }
  // Restore whatever happened above, then report: a dirty worktree would corrupt the entry's evidence.
  for (const test of tests) {
    if (existing.has(test.path)) await git(worktree, ['checkout', candidateSha, '--', test.path]);
    else rmSync(join(worktree, test.path), { force: true });
  }
  const left = await uncommittedPaths(worktree);
  if (left.length) throw new Error(`the worktree was not restored cleanly: ${left.join(', ')}`);
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
