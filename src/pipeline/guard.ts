// The integrity guard. Agents edit tests to make checks pass far more often than one would hope, so a
// round fails when it deletes tests, changes protected paths or leaves work uncommitted, and modified
// tests are named for the reviewer. So are changes to what decides a check's outcome without being a
// test (runner, build and lint settings, scripts a check runs): an agent once made a failing check pass
// by ignoring an exit code for the whole repository. Deterministic: no model is asked whether the tests
// are still valid.
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
  /** Paths that configure how checks run, such as `**\/Directory.Build.props`. */
  checkConfigPatterns: readonly string[];
  /** The spec's check commands: a repository file one of them names is check configuration too. */
  checkCommands: readonly string[];
}

/** Inspect a round's candidate commit against the commit it started from. */
export async function inspectCandidate(input: GuardInput): Promise<GuardResult> {
  const violations: string[] = [];
  const dirty = await uncommittedPaths(input.cwd);
  if (dirty.length) violations.push(`Uncommitted changes remain: ${preview(dirty)}`);
  if (!(await isAncestor(input.cwd, input.fromSha, input.sha))) {
    violations.push(`The branch was rewritten: ${input.fromSha.slice(0, 12)} is no longer an ancestor of HEAD.`);
    return {
      clean: dirty.length === 0,
      commits: 0,
      changedFiles: [],
      violations,
      modifiedTests: [],
      modifiedCheckConfig: [],
    };
  }
  const commits = await commitCount(input.cwd, input.fromSha, input.sha);
  if (commits === 0) violations.push('No new commit: the round must commit its work on the task branch.');
  const changes = await changedPaths(input.cwd, input.fromSha, input.sha);
  const modifiedTests: string[] = [];
  const modifiedCheckConfig: string[] = [];
  const named = new Set(input.checkCommands.flatMap(commandPaths));
  for (const change of changes) {
    const touched = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const guarded = touched.filter(
      path => input.protectedFiles.includes(path) || matchesAny(path, input.protectedGlobs),
    );
    if (guarded.length) violations.push(`Protected path changed (${change.status}): ${guarded.join(' -> ')}`);
    // Added and deleted configuration counts too: a new runner settings file changes a check as surely.
    // Inside a test folder too: a test project's settings are configuration, not a test to read.
    const configures = touched.some(path => named.has(path) || matchesAny(path, input.checkConfigPatterns));
    if (configures) modifiedCheckConfig.push(change.path);
    const before = change.oldPath ?? change.path;
    if (!matchesAny(before, input.testPatterns)) continue;
    if (change.status === 'D') violations.push(`Test file deleted: ${change.path}`);
    else if (change.status === 'R' && !matchesAny(change.path, input.testPatterns))
      violations.push(`Test file renamed out of the test patterns: ${change.oldPath} -> ${change.path}`);
    else if (change.status !== 'A' && !configures) modifiedTests.push(change.path);
  }
  return {
    clean: dirty.length === 0,
    commits,
    changedFiles: changes.map(change => change.path),
    violations,
    modifiedTests,
    modifiedCheckConfig,
  };
}

/** Repository-relative paths a check command may name, such as `scripts/check-docs.mjs` or `App.slnx`. */
function commandPaths(command: string): string[] {
  return command
    .split(/[\s"'=]+/)
    .map(token => token.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(token => token.includes('.') || token.includes('/'));
}

function preview(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}
