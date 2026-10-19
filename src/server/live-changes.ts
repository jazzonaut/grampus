// Owns bounded, display-only observations of working tree changes. Nothing here writes evidence,
// touches the index or runs repository diff drivers; a live read is never a stable artifact snapshot.
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { monitoringLimits, processLimits } from '../config/limits.js';
import type { LiveChangesV1 } from './api-types.js';

function git(
  cwd: string,
  args: string[],
  patch = false,
  filters: string[] = [],
): Promise<{ text: string; truncated: boolean }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return new Promise((accept, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...filters, ...args],
      {
        env,
        windowsHide: true,
        encoding: 'buffer',
        timeout: processLimits.gitTimeoutMs,
        maxBuffer: patch ? monitoringLimits.patchBytes : monitoringLimits.pathBytes,
      },
      (error, stdout) => {
        const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (error && !(patch && truncated) && !expectedDifference(error.code, args, patch, error.killed)) {
          reject(new Error('Live changes could not be read from Git; refresh to try again.'));
        } else accept({ text: stdout.toString('utf8'), truncated });
      },
    );
    child.stdin?.end();
  });
}

function expectedDifference(
  code: string | number | null | undefined,
  args: string[],
  patch: boolean,
  killed: boolean | undefined,
): boolean {
  return code === 1 && !killed && ((patch && args.includes('--no-index')) || args[0] === 'config');
}

/** Git diff can invoke clean filters even with text conversion disabled; override every configured driver. */
async function disabledFilters(cwd: string): Promise<string[]> {
  const configured = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.']);
  const drivers = new Set(
    configured.text.split('\0').flatMap(key => {
      const name = /^filter\.(.+)\.(?:clean|smudge|process|required)$/is.exec(key)?.[1];
      return name === undefined ? [] : [name];
    }),
  );
  return [...drivers].flatMap(name => {
    if (name.includes('=')) throw new Error('Live changes cannot safely disable a configured Git filter');
    return [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.smudge=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ];
  });
}

function requirePlainPath(root: string, path: string): void {
  for (let current = resolve(root, path); current !== root; current = dirname(current)) {
    if (dirname(current) === current) throw new Error('Live preview path is outside the workspace');
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || realpathSync.native(current) !== current || (stat.isFile() && stat.nlink !== 1))
      throw new Error('Live previews do not follow symbolic links, junctions or hard links');
  }
}

/**
 * Observes changes against the task's pinned base, including staged, unstaged and untracked files.
 * Reads only one selected patch. Races with editing are expected: the result is labelled display-only.
 * Throws on unavailable Git output or an invalid path. A reverted selection returns no patch.
 */
export async function readLiveChanges(cwd: string, base: string, path?: string): Promise<LiveChangesV1> {
  const root = realpathSync.native(cwd);
  const filters = await disabledFilters(root);
  const [tracked, untracked] = await Promise.all([
    git(
      root,
      ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'],
      false,
      filters,
    ),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'], false, filters),
  ]);
  const newPaths = new Set(untracked.text.split('\0').filter(Boolean));
  const all = [...new Set([...tracked.text.split('\0').filter(Boolean), ...newPaths])].sort();
  const paths = all.slice(0, monitoringLimits.paths);
  let selected: LiveChangesV1['selected'] = null;
  if (path !== undefined && (path.split(/[\\/]/).includes('..') || /^(?:[A-Za-z]:|[\\/])/.test(path)))
    throw new Error('Select a current changed path to read its live diff');
  if (path !== undefined && all.includes(path)) {
    requirePlainPath(root, path);
    const common = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
    const result = await git(
      root,
      newPaths.has(path) ? [...common, '--no-index', '--', '/dev/null', path] : [...common, base, '--', path],
      true,
      filters,
    );
    const lines = result.text.split('\n');
    selected = {
      path,
      patch: lines.slice(0, monitoringLimits.patchLines).join('\n'),
      truncated: result.truncated || lines.length > monitoringLimits.patchLines,
    };
  }
  return {
    apiVersion: 1,
    observedAt: new Date().toISOString(),
    base,
    paths,
    total: all.length,
    truncated: paths.length < all.length,
    selected,
  };
}
