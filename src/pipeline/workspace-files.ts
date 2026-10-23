// Files exchanged with workers. Most use the excluded `.grampus/` folder for sandbox access;
// polish reports use Git metadata so a worker cannot force-add them to its source changes.
// Durable copies in the task folder preserve evidence after the worktree is removed.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { git } from '../git/git.js';
import { safeName } from '../store/task-store.js';

export const workerFolder = '.grampus';

/** The path a stage's worker writes a file to, e.g. `<worktree>/.grampus/spec-1/spec.md`. */
export function workerFile(worktree: string, key: string, name: string): string {
  const dir = join(worktree, workerFolder, safeName(key));
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/** Keep polish reports in this worktree's Git metadata, where even a force-add cannot commit them. */
export async function privateWorkerFile(worktree: string, key: string, name: string): Promise<string> {
  const gitDir = (await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim();
  const dir = join(gitDir, 'grampus', safeName(key));
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/** The approved spec the builder, tests writer and reviewers read. */
export function approvedSpecPath(worktree: string): string {
  mkdirSync(join(worktree, workerFolder), { recursive: true });
  return join(worktree, workerFolder, 'spec.md');
}

/** Read a worker's file, or null when it does not exist. */
export function readWorkerFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Copy a file into the task folder as evidence. */
export function keepEvidence(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/** Make Git ignore the worker folder in every worktree of the repository, without changing tracked files. */
export async function excludeWorkerFolder(worktree: string): Promise<void> {
  const common = (await git(worktree, ['rev-parse', '--git-common-dir'])).trim();
  const exclude = join(isAbsolute(common) ? common : resolve(worktree, common), 'info', 'exclude');
  const line = `/${workerFolder}/`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}
