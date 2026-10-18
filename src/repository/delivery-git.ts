import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RepositorySnapshot } from './artifacts.js';
import { processLimits, repositoryLimits } from '../config/limits.js';

/** Used inside the supervised writer, and for read-only delivery reconciliation. */
export function deliveryGit(cwd: string, ...args: string[]): Buffer {
  return invokeGit(cwd, args);
}
export function deliveryGitInput(cwd: string, input: Buffer, ...args: string[]): Buffer {
  return invokeGit(cwd, args, input);
}
function invokeGit(cwd: string, args: string[], input?: Buffer): Buffer {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      env,
      windowsHide: true,
      timeout: processLimits.gitTimeoutMs,
      maxBuffer: repositoryLimits.deliveryGitOutputBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input !== undefined ? { input } : {}),
    });
  } catch {
    throw new Error(`Delivery Git ${args[0]} failed; inspect retained repository state before retrying`);
  }
}
export function gitText(cwd: string, ...args: string[]): string {
  return deliveryGit(cwd, ...args)
    .toString('utf8')
    .trim();
}

/** Compare raw blobs, paths and modes, not Git's filtered diff/status interpretation. */
export function verifyTree(cwd: string, snapshot: RepositorySnapshot, tree?: string): void {
  const oldModes = new Map(
    snapshot.index
      .split('\0')
      .filter(Boolean)
      .map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.slice(0, 6)]),
  );
  const expected = new Map(snapshot.files.filter(file => file.sha256 !== null).map(file => [file.path, file]));
  const entries = deliveryGit(cwd, ...(tree ? ['ls-tree', '-r', '-z', tree] : ['ls-files', '--stage', '-z']))
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (entries.length !== expected.size) throw new Error('Delivery tree has different paths from the checked artifact');
  const blobs: { oid: string; sha256: string }[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    const parts = entry.slice(0, tab).split(' ');
    const [mode, oid] = tree ? [parts[0], parts[2]] : parts;
    const file = expected.get(path);
    const wantedMode =
      process.platform === 'win32' ? (oldModes.get(path) ?? '100644') : file?.executable ? '100755' : '100644';
    if (!file || !['100644', '100755'].includes(mode ?? '') || mode !== wantedMode || (!tree && parts[2] !== '0')) {
      throw new Error('Delivery tree path or file mode differs from the checked artifact');
    }
    blobs.push({ oid: oid!, sha256: file.sha256! });
    expected.delete(path);
  }
  if (!blobs.length) return;
  // Size first, then bounded batches: 100k paths must not spawn 100k Git processes.
  const sizes = deliveryGitInput(
    cwd,
    Buffer.from(blobs.map(blob => `${blob.oid}\n`).join('')),
    'cat-file',
    '--batch-check',
  )
    .toString('ascii')
    .trim()
    .split('\n');
  if (sizes.length !== blobs.length) throw new Error('Delivery blob inventory is incomplete');
  const metadata = blobs.map((blob, index) => {
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(sizes[index]!);
    if (!match || match[1] !== blob.oid || Number(match[2]) > repositoryLimits.fileBytes)
      throw new Error('Delivery blob inventory is invalid or oversized');
    return { ...blob, bytes: Number(match[2]) };
  });
  let batch: typeof metadata = [],
    bytes = 0;
  const verify = () => {
    if (!batch.length) return;
    const data = deliveryGitInput(cwd, Buffer.from(batch.map(blob => `${blob.oid}\n`).join('')), 'cat-file', '--batch');
    let offset = 0;
    for (const blob of batch) {
      const end = data.indexOf(10, offset);
      if (end < 0 || data.subarray(offset, end).toString('ascii') !== `${blob.oid} blob ${blob.bytes}`)
        throw new Error('Delivery blob response is invalid');
      offset = end + 1;
      const content = data.subarray(offset, offset + blob.bytes);
      offset += blob.bytes;
      if (
        content.length !== blob.bytes ||
        data[offset++] !== 10 ||
        createHash('sha256').update(content).digest('hex') !== blob.sha256
      ) {
        throw new Error('Delivery tree bytes differ from the checked artifact (including possible Git filters)');
      }
    }
    if (offset !== data.length) throw new Error('Unexpected delivery blob response');
    batch = [];
    bytes = 0;
  };
  for (const blob of metadata) {
    const framed = blob.bytes + repositoryLimits.deliveryBlobOverheadBytes;
    if (bytes + framed > repositoryLimits.deliveryBlobBatchBytes) verify();
    batch.push(blob);
    bytes += framed;
  }
  verify();
}

export interface DeliveryRequest {
  id: string;
  cwd: string;
  branch: string;
  base: string;
  message: string;
  snapshot: RepositorySnapshot;
  mode?: 'commit' | 'no_change';
  orca?: { database: string; executionId: string; workspaceId: string; identityKey: string };
}
/** No-change delivery proves raw HEAD/index/worktree equality without staging. */
export function verifyNoChange(request: DeliveryRequest): void {
  if (
    gitText(request.cwd, 'symbolic-ref', 'HEAD') !== request.branch ||
    gitText(request.cwd, 'rev-parse', 'HEAD') !== request.snapshot.head
  )
    throw new Error('No-change delivery branch or HEAD changed');
  verifyTree(request.cwd, request.snapshot, request.snapshot.head);
  verifyTree(request.cwd, request.snapshot);
}
export function deliveryMessage(request: DeliveryRequest): string {
  return `${request.message.trim()}\n\nGrampus-Delivery: ${request.id}\n`;
}
export function verifyCommit(request: DeliveryRequest): string {
  const { cwd, snapshot } = request;
  if (gitText(cwd, 'symbolic-ref', 'HEAD') !== request.branch) throw new Error('Delivery branch changed');
  const commit = gitText(cwd, 'rev-parse', 'HEAD');
  const raw = deliveryGit(cwd, 'cat-file', 'commit', commit).toString('utf8');
  const separator = raw.indexOf('\n\n');
  const parents = raw
    .slice(0, separator)
    .split('\n')
    .filter(line => line.startsWith('parent '));
  if (parents.length !== 1 || parents[0] !== `parent ${snapshot.head}`)
    throw new Error('Delivery commit does not have the expected single parent');
  if (raw.slice(separator + 2).trim() !== deliveryMessage(request).trim())
    throw new Error('Delivery commit message or operation marker does not match');
  verifyTree(cwd, snapshot, commit);
  verifyTree(cwd, snapshot);
  return commit;
}
