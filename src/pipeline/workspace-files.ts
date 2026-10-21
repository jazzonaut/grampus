// Files exchanged with workers. Workers write inside the task worktree, under `.grampus/`, because
// agent sandboxes may refuse writes elsewhere. Grampus excludes that folder from Git (through the
// repository's `info/exclude`, never a committed file) and copies each file into the task folder as
// evidence that survives the worktree.
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
