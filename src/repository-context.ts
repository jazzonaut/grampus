import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { deliveryGit, deliveryGitInput } from './delivery-git.js';

export const contextLimits = { bytes: 512 * 1024, fileBytes: 256 * 1024, files: 256 };
export interface RepositoryEntry { path: string; oid: string; bytes: number }
export interface ContextSummary {
  inventoryDigest: string; digest: string; totalFiles: number; totalBytes: number;
  includedFiles: number; omittedFiles: number; bytes: number;
  selected: string[]; directories: { path: string; files: number }[];
}
export interface PinnedRepository {
  entries: RepositoryEntry[]; byPath: Map<string, RepositoryEntry>; totalBytes: number;
  digest: string; directories: ContextSummary['directories'];
}
// Commit trees are immutable. Cache metadata only, never mutable worktree bytes.
// Bound memory as well as entry count; a large tree must not multiply per poll.
const cache = new Map<string, { tree: PinnedRepository; bytes: number }>();
let cachedBytes = 0;
export function pinnedRepository(repo: string, base: string, subtree = ''): PinnedRepository {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Repository context requires a pinned commit');
  if (subtree.includes('\0') || subtree.split('/').some(part => part === '..')) throw new Error('Invalid repository subtree');
  const key = `${repo}\0${base}\0${subtree}`, found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found.tree; }
  const raw = deliveryGit(repo, 'ls-tree', '-r', '-l', '-z', base, ...(subtree ? ['--', subtree] : []));
  const directories = new Map<string, number>();
  let totalBytes = 0;
  const entries = raw.toString('utf8').split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Repository context requires regular files; symlinks and submodules are unsupported');
    const path = match[4]!;
    if (path.includes('\ufffd')) throw new Error('Repository paths must be valid UTF-8');
    const bytes = Number(match[3]); totalBytes += bytes;
    const directory = path.includes('/') ? path.slice(0, path.indexOf('/')) + '/' : '(root)';
    directories.set(directory, (directories.get(directory) ?? 0) + 1);
    return { path, oid: match[2]!, bytes };
  });
  const tree: PinnedRepository = { entries, byPath: new Map(entries.map(entry => [entry.path, entry])), totalBytes,
    digest: createHash('sha256').update(raw).digest('hex'),
    directories: [...directories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([path, files]) => ({ path, files })) };
  const bytes = raw.length * 4;
  while (cache.size && (cache.size >= 4 || cachedBytes + bytes > 64 * 1024 * 1024)) {
    const oldest = cache.keys().next().value!; cachedBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
  }
  if (bytes <= 64 * 1024 * 1024) { cache.set(key, { tree, bytes }); cachedBytes += bytes; }
  return tree;
}

export function contextPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > contextLimits.files || value.some(path => typeof path !== 'string' || !path || path.includes('\0'))
    || new Set(value).size !== value.length) throw new Error('Context files must be at most 256 distinct exact repository paths');
  return [...value] as string[];
}
export const instructionPath = (path: string) => ['AGENTS.md', 'CLAUDE.md'].includes(basename(path));

export function summarizeContext(tree: PinnedRepository, selected: string[], bytes: number): ContextSummary {
  return { inventoryDigest: tree.digest, digest: createHash('sha256').update(JSON.stringify({ inventory: tree.digest, selected })).digest('hex'),
    totalFiles: tree.entries.length, totalBytes: tree.totalBytes, includedFiles: selected.length,
    omittedFiles: tree.entries.length - selected.filter(path => tree.byPath.has(path)).length, bytes, selected, directories: tree.directories };
}

/** One batch for selected blobs. No Git process or filesystem traversal per file. */
export function pinnedContext(repo: string, base: string, selection?: unknown, request = '') {
  const tree = pinnedRepository(repo, base), explicit = selection !== undefined;
  const required = tree.entries.filter(entry => instructionPath(entry.path));
  const requested = explicit ? contextPaths(selection).map(path => {
    const entry = tree.byPath.get(path); if (!entry) throw new Error(`Context file is absent from the pinned commit: ${path}`); return entry;
  }) : suggestedEntries(tree, request);
  const chosen: RepositoryEntry[] = [], seen = new Set<string>(); let bytes = 0;
  for (const entry of [...required, ...requested]) {
    if (seen.has(entry.path)) continue;
    const mandatory = explicit || instructionPath(entry.path);
    if (entry.bytes > contextLimits.fileBytes || bytes + entry.bytes > contextLimits.bytes || chosen.length >= contextLimits.files) {
      if (mandatory) throw new Error(`Selected context exceeds its budget at ${entry.path}. Select up to 256 text files, 256 KiB each and 512 KiB total.`);
      continue;
    }
    chosen.push(entry); seen.add(entry.path); bytes += entry.bytes;
  }
  const blobs = chosen.length ? deliveryGitInput(repo, Buffer.from(chosen.map(entry => `${entry.oid}\n`).join('')), 'cat-file', '--batch') : Buffer.alloc(0);
  let offset = 0;
  const files: { path: string; content: string }[] = [];
  for (const entry of chosen) {
    const end = blobs.indexOf(10, offset);
    if (end < 0 || blobs.subarray(offset, end).toString('ascii') !== `${entry.oid} blob ${entry.bytes}`) throw new Error('Pinned context blob response is invalid');
    offset = end + 1; const data = blobs.subarray(offset, offset + entry.bytes); offset += entry.bytes;
    if (data.length !== entry.bytes || blobs[offset++] !== 10) throw new Error('Pinned context blob response is incomplete');
    if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) {
      if (explicit || instructionPath(entry.path)) throw new Error(`Selected context file must be UTF-8 text: ${entry.path}`);
      continue;
    }
    files.push({ path: entry.path, content: data.toString('utf8') });
  }
  return { files, summary: summarizeContext(tree, files.map(file => file.path), files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)) };
}

function suggestedEntries(tree: PinnedRepository, request: string): RepositoryEntry[] {
  // Suggestions are explicitly partial, not a claim that dependencies were analysed.
  const terms = [...new Set(request.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])].filter(term => !['the', 'and', 'with', 'this', 'that', 'for', 'from', 'should', 'change', 'file'].includes(term)).slice(0, 32);
  return tree.entries.map((entry, index) => {
    const path = entry.path.toLowerCase(), name = basename(path);
    const score = terms.reduce((sum, term) => sum + (path.includes(term) ? 20 : 0), 0)
      + (/^(readme(?:\.[^/]+)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json|makefile)$/i.test(entry.path) ? 30 : 0)
      + (/\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|rb|php|vue|svelte|html|css|json|md|toml|ya?ml)$/i.test(name) ? 2 : 0)
      - (/lock|generated|vendor|dist\/|build\//.test(path) ? 40 : 0);
    return { entry, score, index };
  }).filter(item => item.score >= 0 && item.entry.bytes <= contextLimits.fileBytes)
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 64).map(item => item.entry);
}

export function searchPinnedFiles(repo: string, base: string, query = '', offset = 0) {
  const tree = pinnedRepository(repo, base);
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof query !== 'string' || query.length > 512) throw new Error('Invalid repository search');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0; const files: RepositoryEntry[] = [];
  for (const entry of tree.entries) if (words.every(word => entry.path.toLowerCase().includes(word))) {
    if (matches >= offset && files.length < 100) files.push(entry); matches++;
  }
  return { files, matches, offset, nextOffset: offset + files.length < matches ? offset + files.length : null, inventoryDigest: tree.digest };
}
