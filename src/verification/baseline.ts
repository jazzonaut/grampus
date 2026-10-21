// Owns the "does this check fail without the change?" run: the failed check's exact command, run on
// a read-only export of the commit the candidate started from. It never touches the workspace or Git
// state, and its result only decides whether a repair is worth spending; it is never evidence.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { commandLimits, processLimits } from '../config/limits.js';
import { runCheckProcess, type CheckProcessOptions, type CheckProcessResult } from '../process/check-process.js';
import type { RepositoryCheck } from './checks.js';
import { outputExcerpt } from './check-output.js';

const run = promisify(execFile);

/** Installed dependency folders a starting-commit export can reuse from the workspace. */
const dependencyFolders = new Set(['node_modules', '.venv', 'venv']);

/** Manifests whose change means the workspace's installed dependencies may not fit the starting commit. */
const dependencyManifests = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
]);

/** What the starting commit showed: `failed` only for a confirmed, fully observed failure. */
export interface BaselineOutcome {
  outcome: 'failed' | 'passed' | 'inconclusive';
  /** Why, in one line, for the journal and the stop note. */
  reason: string;
  /** The commit the check ran on. */
  head: string;
  /** A bounded excerpt of the failure when it failed. */
  issue: string | null;
}

/** A process runner; tests replace the supervised one. */
type Runner = (options: CheckProcessOptions) => Promise<CheckProcessResult>;

/** Windows' own bsdtar: Git's GNU tar reads `C:\...` as a remote host. */
function tarExecutable(): string {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/** Ignored dependency folders in the workspace, at any depth, as repository-relative paths. */
async function installedDependencies(cwd: string): Promise<string[]> {
  const { stdout } = await run(
    'git',
    ['-C', cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    { maxBuffer: commandLimits.previewBytes * 64, windowsHide: true },
  );
  return stdout
    .split('\0')
    .map(entry => entry.replace(/\/$/, ''))
    .filter(entry => entry && dependencyFolders.has(basename(entry)));
}

/** Exports `head` into `tree` with its own empty repository and links the installed dependencies. */
async function exportStartingCommit(workspace: string, head: string, root: string, tree: string): Promise<string[]> {
  const archive = join(root, 'head.tar');
  // Read-only on the workspace repository. The export gets its own empty repository so tooling that
  // calls Git finds it rather than walking up into whatever repository contains the temp folder.
  await run('git', ['-C', workspace, 'archive', '--format=tar', '-o', archive, head], { windowsHide: true });
  await run('git', ['init', '-q', tree], { windowsHide: true });
  await run(tarExecutable(), ['-xf', archive, '-C', tree], { windowsHide: true });
  const links: string[] = [];
  for (const folder of await installedDependencies(workspace)) {
    const target = join(tree, folder);
    if (existsSync(target) || !existsSync(dirname(target))) continue;
    symlinkSync(join(workspace, folder), target, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(target);
  }
  return links;
}

/** Whether a settled run on the starting commit failed, passed or cannot stand for it. */
function classify(check: RepositoryCheck, result: CheckProcessResult, head: string): BaselineOutcome {
  if (result.reason !== 'exited' || !result.exitConfirmed || result.outputUnavailable || result.outputTruncated)
    return {
      outcome: 'inconclusive',
      reason: `The run on the starting commit did not settle cleanly (${result.reason})`,
      head,
      issue: null,
    };
  const expected = check.spec.expectedStdout;
  const stderr = check.spec.expectations?.stderr;
  const failed =
    result.exitCode !== 0 ||
    (expected !== undefined && result.stdout !== expected) ||
    (stderr !== undefined && result.stderr !== stderr);
  return failed
    ? {
        outcome: 'failed',
        reason: `The same command fails on ${head.slice(0, 12)} without this change (exit ${result.exitCode ?? 'unknown'})`,
        head,
        issue: outputExcerpt(`${result.stderr}\n${result.stdout}`, processLimits.baselineIssueCharacters),
      }
    : {
        outcome: 'passed',
        reason: `The same command passes on ${head.slice(0, 12)}, so the change caused the failure`,
        head,
        issue: null,
      };
}

/**
 * Reruns `check`'s command on an export of `start.head`, reusing the workspace's installed
 * dependency folders through links. Returns `inconclusive` rather than guessing whenever the export
 * cannot stand for the starting commit (changed dependency manifests, an unconfirmed or partial run,
 * any setup error), so only a confirmed failure there can stop a repair.
 */
export async function runOnStartingCommit(
  workspace: string,
  check: RepositoryCheck,
  start: { head: string; changedPaths: readonly string[] },
  options: { signal?: AbortSignal; runner?: Runner } = {},
): Promise<BaselineOutcome> {
  const { head } = start;
  if (start.changedPaths.some(path => dependencyManifests.has(basename(path))))
    return {
      outcome: 'inconclusive',
      reason: 'The change edits dependency manifests, so installed dependencies cannot be reused',
      head,
      issue: null,
    };
  const root = mkdtempSync(join(tmpdir(), 'grampus-baseline-'));
  const tree = join(root, 'tree');
  let links: string[] = [];
  try {
    links = await exportStartingCommit(workspace, head, root, tree);
    const result = await (options.runner ?? runCheckProcess)({
      file: check.spec.file,
      args: check.spec.args,
      cwd: tree,
      timeoutMs: check.spec.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      started: () => {},
    });
    return classify(check, result, head);
  } catch (error) {
    return {
      outcome: 'inconclusive',
      reason: error instanceof Error ? error.message : String(error),
      head,
      issue: null,
    };
  } finally {
    // Unlink the dependency links first so removing the export can never reach the workspace's folders.
    for (const link of links) unlinkSync(link);
    rmSync(root, { recursive: true, force: true, maxRetries: processLimits.baselineCleanupRetries });
  }
}
