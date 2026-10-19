// Owns raw synchronous Git plumbing for delivery and reconciliation, and the byte-level checks that a tree,
// index or commit holds exactly the checked artifact. It compares raw blobs, never Git's filtered diff or
// status, and it must never reset, amend or push.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RepositorySnapshot } from './artifacts.js';
import type { DeliveryRequest } from '../persistence/records.js';
import { blobCheckLine, indexEntry, lsTreeEntry } from './git-output.js';
import { processLimits, repositoryLimits } from '../config/limits.js';

/**
 * Used inside the supervised writer, and for read-only delivery reconciliation; other modules also use it
 * for read-only plumbing such as `rev-parse`, `ls-tree` and `cat-file`. Inherited `GIT_*` variables are
 * dropped so the explicit `cwd` decides the repository, replace refs are ignored so objects read as stored,
 * and optional locks and fsmonitor are off. Hooks and repository configuration still apply to writes.
 *
 * @throws Error naming only the subcommand on any failure, timeout or oversized output; Git's own output
 *   is never echoed.
 */
export function deliveryGit(cwd: string, ...args: string[]): Buffer {
  return invokeGit(cwd, args);
}
/** `deliveryGit` with `input` on stdin, for batch plumbing such as `cat-file --batch`. */
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
/** `deliveryGit` output as trimmed UTF-8 text; throws as `deliveryGit` does. */
export function gitText(cwd: string, ...args: string[]): string {
  return deliveryGit(cwd, ...args)
    .toString('utf8')
    .trim();
}

/**
 * Compare raw blobs, paths and modes, not Git's filtered diff/status interpretation.
 *
 * With `tree` the commit or tree is checked, otherwise the index (which must hold only stage 0 entries).
 * The paths must be exactly the snapshot's present files, each a regular file with the expected mode, and
 * each blob's SHA-256 must equal the snapshot's hash of the working file bytes, so a clean filter or
 * line-ending conversion applied while staging is caught here.
 *
 * @throws Error on any difference in paths, modes, sizes or bytes, or on a malformed Git response.
 */
export function verifyTree(cwd: string, snapshot: RepositorySnapshot, tree?: string): void {
  const oldModes = new Map(
    snapshot.index
      .split('\0')
      .filter(Boolean)
      .map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.slice(0, 6)]),
  );
  const expected = new Map(
    snapshot.files.flatMap(file =>
      file.sha256 === null ? [] : [[file.path, { executable: file.executable, sha256: file.sha256 }] as const],
    ),
  );
  const entries = deliveryGit(cwd, ...(tree ? ['ls-tree', '-r', '-z', tree] : ['ls-files', '--stage', '-z']))
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (entries.length !== expected.size) throw new Error('Delivery tree has different paths from the checked artifact');
  const blobs: { oid: string; sha256: string }[] = [];
  for (const entry of entries) {
    const { mode, oid, path, stage } = tree ? { ...lsTreeEntry(entry), stage: '0' } : indexEntry(entry);
    const file = expected.get(path);
    // Windows working files carry no executable bit, so the mode must stay as the checked index had it
    // (new paths are 100644); elsewhere it follows the file's executable bit in the snapshot.
    const wantedMode =
      process.platform === 'win32' ? (oldModes.get(path) ?? '100644') : file?.executable ? '100755' : '100644';
    if (!file || !['100644', '100755'].includes(mode) || mode !== wantedMode || stage !== '0') {
      throw new Error('Delivery tree path or file mode differs from the checked artifact');
    }
    blobs.push({ oid, sha256: file.sha256 });
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
    const checked = blobCheckLine(sizes[index]);
    if (checked?.oid !== blob.oid || checked.bytes > repositoryLimits.fileBytes)
      throw new Error('Delivery blob inventory is invalid or oversized');
    return { ...blob, bytes: checked.bytes };
  });
  let batch: typeof metadata = [],
    bytes = 0;
  // `cat-file --batch` prints `<oid> blob <size>\n<raw bytes>\n` per object, unfiltered, so each frame is
  // parsed strictly and the whole response must be consumed.
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

export type { DeliveryRequest } from '../persistence/records.js';
/**
 * No-change delivery proves raw HEAD/index/worktree equality without staging.
 *
 * This function checks the branch, HEAD, the HEAD tree and the index against the snapshot; working file
 * equality comes from the caller comparing a fresh snapshot with the same one.
 *
 * @throws Error when the branch or HEAD moved, or the HEAD tree or index differs from the snapshot.
 */
export function verifyNoChange(request: DeliveryRequest): void {
  if (
    gitText(request.cwd, 'symbolic-ref', 'HEAD') !== request.branch ||
    gitText(request.cwd, 'rev-parse', 'HEAD') !== request.snapshot.head
  )
    throw new Error('No-change delivery branch or HEAD changed');
  verifyTree(request.cwd, request.snapshot, request.snapshot.head);
  verifyTree(request.cwd, request.snapshot);
}
/**
 * The exact commit message: the approved message plus a `Grampus-Delivery: <id>` trailer, which is how
 * `verifyCommit` ties a commit to one delivery operation.
 */
export function deliveryMessage(request: DeliveryRequest): string {
  return `${request.message.trim()}\n\nGrampus-Delivery: ${request.id}\n`;
}
/**
 * Verify the delivered commit at HEAD on the delivery branch: exactly one parent (the checked HEAD), the
 * exact message and marker, and a tree and index holding the checked artifact. Returns the commit id.
 *
 * @throws Error when the branch changed, the parent or message differs, or the tree or index differs.
 */
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
