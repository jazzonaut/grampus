// The integrity guard. Agents edit tests to make checks pass far more often than one would hope, so a
// round fails when it deletes tests, changes protected paths or leaves work uncommitted, and modified
// tests are named for the reviewer. Deterministic: no model is asked whether the tests are still valid.
import type { GuardResult } from '../domain/events.js';
import { changedPaths, commitCount, isAncestor, uncommittedPaths } from '../git/git.js';
import { matchesAny } from '../util/glob.js';

export interface GuardInput {
  cwd: string;
  /** The commit the round started from. */
  fromSha: string;
  /** The candidate commit. */
  sha: string;
  protectedGlobs: readonly string[];
  /** Exact paths that must not change, such as acceptance tests written before the build. */
  protectedFiles: readonly string[];
  testPatterns: readonly string[];
}

/** Inspect a round's candidate commit against the commit it started from. */
export async function inspectCandidate(input: GuardInput): Promise<GuardResult> {
  const violations: string[] = [];
  const dirty = await uncommittedPaths(input.cwd);
  if (dirty.length) violations.push(`Uncommitted changes remain: ${preview(dirty)}`);
  if (!(await isAncestor(input.cwd, input.fromSha, input.sha))) {
    violations.push(`The branch was rewritten: ${input.fromSha.slice(0, 12)} is no longer an ancestor of HEAD.`);
    return { clean: dirty.length === 0, commits: 0, changedFiles: [], violations, modifiedTests: [] };
  }
  const commits = await commitCount(input.cwd, input.fromSha, input.sha);
  if (commits === 0) violations.push('No new commit: the round must commit its work on the task branch.');
  const changes = await changedPaths(input.cwd, input.fromSha, input.sha);
  const modifiedTests: string[] = [];
  for (const change of changes) {
    const touched = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const guarded = touched.filter(
      path => input.protectedFiles.includes(path) || matchesAny(path, input.protectedGlobs),
    );
    if (guarded.length) violations.push(`Protected path changed (${change.status}): ${guarded.join(' -> ')}`);
    const before = change.oldPath ?? change.path;
    if (!matchesAny(before, input.testPatterns)) continue;
    if (change.status === 'D') violations.push(`Test file deleted: ${change.path}`);
    else if (change.status === 'R' && !matchesAny(change.path, input.testPatterns))
      violations.push(`Test file renamed out of the test patterns: ${change.oldPath} -> ${change.path}`);
    else if (change.status !== 'A') modifiedTests.push(change.path);
  }
  return {
    clean: dirty.length === 0,
    commits,
    changedFiles: changes.map(change => change.path),
    violations,
    modifiedTests,
  };
}

function preview(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}
