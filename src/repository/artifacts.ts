// Owns repository snapshots: the content evidence every check, review and delivery is bound to, read
// through Git plumbing with no filters, hooks or diff drivers, and hashed into one artifact digest.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { formatBytes, processLimits, repositoryLimits } from '../config/limits.js';
import type { RepositorySnapshot } from './snapshot-schema.js';
import { lsTreeLongEntry } from './git-output.js';
import { systemErrorCode } from '../process/boundary.js';

export type { RepositorySnapshot } from './snapshot-schema.js';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Read-only Git with inherited `GIT_*` variables dropped, so `cwd` alone decides the repository. */
function gitBytes(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      {
        env,
        windowsHide: true,
        timeout: processLimits.gitTimeoutMs,
        maxBuffer: repositoryLimits.gitOutputBytes,
        encoding: 'buffer',
      },
      (error, stdout) => (error ? reject(new Error(`Snapshot Git ${args[0]} failed`)) : resolveResult(stdout)),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitBytes(cwd, args)).toString('utf8');
}
/** UTF-8 only when the bytes round-trip exactly and contain no NUL; anything else is kept as base64. */
function encoding(content: Buffer | null): 'utf8' | 'base64' {
  return content !== null && !content.includes(0) && Buffer.from(content.toString('utf8')).equals(content)
    ? 'utf8'
    : 'base64';
}

type Baseline = Map<string, { mode: string; oid: string; bytes: number }>;
type Change = RepositorySnapshot['diff'][number];

/** The raw staged index; only resolved regular files are supported, so an index entry is never a link or submodule. */
async function stagedIndex(cwd: string): Promise<string> {
  const index = await git(cwd, ['ls-files', '--stage', '-z']);
  if (
    index
      .split('\0')
      .filter(Boolean)
      .some(entry => !/^100(644|755) [a-f0-9]+ 0\t/.test(entry))
  ) {
    throw new Error('Snapshots require regular files and a resolved index; submodules and symlinks are unsupported');
  }
  return index;
}

/** Every blob of the pinned base tree with its mode, object id and size. */
async function baselineTree(cwd: string, base: string): Promise<Baseline> {
  const baseline: Baseline = new Map();
  for (const entry of (await git(cwd, ['ls-tree', '-r', '-l', '-z', base])).split('\0').filter(Boolean)) {
    const { mode, type, oid, size, path } = lsTreeLongEntry(entry);
    if (type !== 'blob' || mode === '120000') throw new Error('Submodule and symlink snapshots are not supported yet');
    baseline.set(path, { mode, oid, bytes: size });
  }
  return baseline;
}

/** The bytes of a regular file within the per-file limit, or null when it does not exist. */
function readEvidenceFile(path: string): Buffer | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Snapshot requires regular files; symlinks and special files are unsupported');
  // Process each file separately; repository byte count is not prompt or memory size.
  if (stat.size > repositoryLimits.fileBytes)
    throw new Error(`Repository file exceeds the ${formatBytes(repositoryLimits.fileBytes)} snapshot limit: ${path}`);
  return readFileSync(path);
}

/** Throws unless `name` stays inside the worktree without passing through a symbolic link. */
function requirePlainPath(cwd: string, name: string, path: string): void {
  const part = relative(cwd, path);
  if (!part || part.startsWith(`..${sep}`) || part === '..' || name.includes('�'))
    throw new Error('Unsupported repository path');
  for (let parent = dirname(path); parent !== resolve(cwd); parent = dirname(parent)) {
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error('Snapshot path traverses a symlink');
    } catch (error) {
      if (systemErrorCode(error) !== 'ENOENT') throw error;
    }
  }
}

/**
 * The change record of a file whose Git blob id differs from the base, with its current bytes. The
 * previous bytes are filled in afterwards by {@link attachPreviousContents} in one batch.
 */
function fileChange(name: string, content: Buffer | null, before: string | null, objectFormat: string): Change | null {
  // The blob id is computed here from the raw bytes rather than by `git hash-object`, which could run filters.
  const oid =
    content === null ? null : createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest('hex');
  if (oid === before) return null;
  // Retain old/new bytes and immutable Git blob identities. No filters, hooks,
  // textconv or external diff drivers execute during evidence collection.
  return {
    path: name,
    before,
    after: oid,
    encoding: encoding(content),
    content: content?.toString(encoding(content)) ?? null,
    previousEncoding: 'base64',
    previousContent: null,
  };
}

/** Reads every changed file's base blob with one `cat-file --batch` and checks each response header. */
async function attachPreviousContents(cwd: string, diff: Change[], baseline: Baseline): Promise<void> {
  const previousFiles = diff.filter(file => file.before !== null);
  if (!previousFiles.length) return;
  const data = await gitBytes(
    cwd,
    ['cat-file', '--batch'],
    Buffer.from(previousFiles.map(file => `${file.before}\n`).join('')),
  );
  let offset = 0;
  for (const file of previousFiles) {
    const original = baseline.get(file.path);
    if (!original) throw new Error('Snapshot baseline is missing a changed file');
    const bytes = original.bytes,
      end = data.indexOf(10, offset);
    if (end < 0 || data.subarray(offset, end).toString('ascii') !== `${file.before} blob ${bytes}`)
      throw new Error('Snapshot blob response is invalid');
    offset = end + 1;
    const previous = data.subarray(offset, offset + bytes);
    offset += bytes;
    if (previous.length !== bytes || data[offset++] !== 10) throw new Error('Snapshot blob response is incomplete');
    file.previousEncoding = encoding(previous);
    file.previousContent = previous.toString(file.previousEncoding);
  }
  if (offset !== data.length) throw new Error('Unexpected snapshot blob response');
}

/**
 * Adds root instructions even when ignored, and those inherited from ancestor directories outside the
 * worktree, which agents also read and which therefore belong to the instructions digest.
 */
function addInheritedInstructions(cwd: string, instructions: RepositorySnapshot['instructions']): void {
  let parent = resolve(cwd);
  let level = 0;
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      if (level === 0 && instructions.some(item => item.path === name)) continue;
      const content = readEvidenceFile(join(parent, name));
      if (content !== null)
        instructions.push({
          path: level === 0 ? name : `<ancestor:${level}>/${name}`,
          content: content.toString('utf8'),
        });
    }
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
    level++;
  }
}

/**
 * Content evidence, not a filesystem sandbox: HEAD, the staged index, every tracked or unignored file
 * with its digest, the changes against the pinned base with old and new bytes, and the repository
 * instructions. The artifact digest covers all of it, so any change to the evidence changes the
 * artifact. Ignored dependencies and external state are excluded.
 *
 * One call is a single read; `captureRepository` (repository-evidence.ts) compares two for a stable capture.
 *
 * @throws Error for a symlink, submodule, special file or unresolved index entry, a path outside the
 *   worktree, a file over the per-file limit, change evidence over its limit, or a failed Git read.
 */
export async function snapshotRepository(cwd: string, base: string): Promise<RepositorySnapshot> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const index = await stagedIndex(cwd);
  const objectFormat = (await git(cwd, ['rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
  const baseline = await baselineTree(cwd, base);
  const names = [
    ...new Set([
      ...baseline.keys(),
      ...(await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean),
    ]),
  ].sort();
  const files: RepositorySnapshot['files'] = [];
  const instructions: RepositorySnapshot['instructions'] = [];
  const diff: RepositorySnapshot['diff'] = [];
  let retainedBytes = 0;
  for (const name of names) {
    const path = resolve(cwd, name);
    requirePlainPath(cwd, name, path);
    const content = readEvidenceFile(path);
    files.push({
      path: name,
      sha256: content === null ? null : digest(content),
      executable: content !== null && process.platform !== 'win32' && !!(lstatSync(path).mode & 0o111),
    });
    if (content !== null && ['AGENTS.md', 'CLAUDE.md'].includes(basename(name)))
      instructions.push({ path: name, content: content.toString('utf8') });
    const original = baseline.get(name);
    const change = fileChange(name, content, original?.oid ?? null, objectFormat);
    if (!change) continue;
    // Refuse oversized evidence while collecting it, before retaining a repository-wide diff.
    retainedBytes += Buffer.byteLength(JSON.stringify(change)) + (original?.bytes ?? 0);
    if (retainedBytes > repositoryLimits.changeEvidenceBytes)
      throw new Error('Repository change evidence exceeds the current size limit');
    diff.push(change);
  }
  await attachPreviousContents(cwd, diff, baseline);
  addInheritedInstructions(cwd, instructions);
  if (Buffer.byteLength(JSON.stringify(diff)) > repositoryLimits.changeEvidenceBytes)
    throw new Error('Repository change evidence exceeds the current size limit');
  const instructionsDigest = digest(JSON.stringify(instructions));
  const artifact = `sha256:${digest(JSON.stringify({ head, index, files, diff, instructionsDigest }))}`;
  return { artifact, head, index, files, diff, instructions, instructionsDigest };
}
