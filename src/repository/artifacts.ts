import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export interface RepositorySnapshot {
  artifact: string;
  head: string;
  index: string;
  files: { path: string; sha256: string | null; executable: boolean }[];
  diff: {
    path: string;
    before: string | null;
    after: string | null;
    encoding: 'utf8' | 'base64';
    content: string | null;
    previousEncoding: 'utf8' | 'base64';
    previousContent: string | null;
  }[];
  instructions: { path: string; content: string }[];
  instructionsDigest: string;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function gitBytes(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => (error ? reject(new Error(`Snapshot Git ${args[0]} failed`)) : resolveResult(stdout)),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitBytes(cwd, args)).toString('utf8');
}
function encoding(content: Buffer | null): 'utf8' | 'base64' {
  return content !== null && !content.includes(0) && Buffer.from(content.toString('utf8')).equals(content)
    ? 'utf8'
    : 'base64';
}

/** Content evidence, not a filesystem sandbox. Ignored dependencies and external state are excluded. */
export async function snapshotRepository(cwd: string, base: string): Promise<RepositorySnapshot> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const index = await git(cwd, ['ls-files', '--stage', '-z']);
  if (
    index
      .split('\0')
      .filter(Boolean)
      .some(entry => !/^100(644|755) [a-f0-9]+ 0\t/.test(entry))
  ) {
    throw new Error('Snapshots require regular files and a resolved index; submodules and symlinks are unsupported');
  }
  const objectFormat = (await git(cwd, ['rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
  const baseline = new Map<string, { mode: string; oid: string; bytes: number }>();
  for (const entry of (await git(cwd, ['ls-tree', '-r', '-l', '-z', base])).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || mode === '120000') throw new Error('Submodule and symlink snapshots are not supported yet');
    baseline.set(entry.slice(tab + 1), { mode: mode!, oid: oid!, bytes: Number(size) });
  }
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
  const read = (path: string): Buffer | null => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Snapshot requires regular files; symlinks and special files are unsupported');
    // Process each file separately; repository byte count is not prompt or memory size.
    if (stat.size > 32 * 1024 * 1024) throw new Error(`Repository file exceeds the 32 MiB snapshot limit: ${path}`);
    return readFileSync(path);
  };
  for (const name of names) {
    const path = resolve(cwd, name);
    const part = relative(cwd, path);
    if (!part || part.startsWith(`..${sep}`) || part === '..' || name.includes('\ufffd'))
      throw new Error('Unsupported repository path');
    for (let parent = dirname(path); parent !== resolve(cwd); parent = dirname(parent)) {
      try {
        if (lstatSync(parent).isSymbolicLink()) throw new Error('Snapshot path traverses a symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const content = read(path);
    files.push({
      path: name,
      sha256: content === null ? null : digest(content),
      executable: content !== null && process.platform !== 'win32' && !!(lstatSync(path).mode & 0o111),
    });
    if (content !== null && ['AGENTS.md', 'CLAUDE.md'].includes(basename(name)))
      instructions.push({ path: name, content: content.toString('utf8') });
    const original = baseline.get(name);
    const oid =
      content === null
        ? null
        : createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest('hex');
    if (oid !== (original?.oid ?? null)) {
      // Retain old/new bytes and immutable Git blob identities. No filters, hooks,
      // textconv or external diff drivers execute during evidence collection.
      const change: RepositorySnapshot['diff'][number] = {
        path: name,
        before: original?.oid ?? null,
        after: oid,
        encoding: encoding(content),
        content: content?.toString(encoding(content)) ?? null,
        previousEncoding: 'base64',
        previousContent: null,
      };
      // Refuse oversized evidence while collecting it, before retaining a repository-wide diff.
      retainedBytes += Buffer.byteLength(JSON.stringify(change)) + (original?.bytes ?? 0);
      if (retainedBytes > 4 * 1024 * 1024) throw new Error('Repository change evidence exceeds the current size limit');
      diff.push(change);
    }
  }
  const previousFiles = diff.filter(file => file.before !== null);
  if (previousFiles.length) {
    const data = await gitBytes(
      cwd,
      ['cat-file', '--batch'],
      Buffer.from(previousFiles.map(file => `${file.before}\n`).join('')),
    );
    let offset = 0;
    for (const file of previousFiles) {
      const bytes = baseline.get(file.path)!.bytes,
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
  // Include root rules even when ignored, and inherited rules outside the worktree.
  let parent = resolve(cwd);
  let level = 0;
  while (true) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      if (level === 0 && instructions.some(item => item.path === name)) continue;
      const content = read(join(parent, name));
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
  if (Buffer.byteLength(JSON.stringify(diff)) > 4 * 1024 * 1024)
    throw new Error('Repository change evidence exceeds the current size limit');
  const instructionsDigest = digest(JSON.stringify(instructions));
  const artifact = `sha256:${digest(JSON.stringify({ head, index, files, diff, instructionsDigest }))}`;
  return { artifact, head, index, files, diff, instructions, instructionsDigest };
}
