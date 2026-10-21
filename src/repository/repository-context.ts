// Owns pinned repository inventories: the file list of an immutable commit (cached by metadata only), the
// bounded planner context drawn from it and path search over it. It reads Git objects, never the mutable
// worktree, so what a planner saw is reproducible from the commit and its digests.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { deliveryGit, deliveryGitInput } from './delivery-git.js';
import { contextLimits, formatBytes, repositoryLimits } from '../config/limits.js';
import { z } from 'zod';

const contextBudget = `Select up to ${contextLimits.files} text files, ${formatBytes(contextLimits.fileBytes)} each and ${formatBytes(contextLimits.bytes)} in total as encoded in the prompt.`;
/** One regular file of a pinned commit: its path, blob id and size in bytes. */
export interface RepositoryEntry {
  path: string;
  oid: string;
  bytes: number;
}
/**
 * What a planner was shown of the pinned repository: the inventory it was drawn from, the selected
 * files and a directory map, so a reply can be checked against what the planner actually saw.
 */
export const contextSummarySchema = z.object({
  inventoryDigest: z.string(),
  digest: z.string(),
  totalFiles: z.number(),
  totalBytes: z.number(),
  includedFiles: z.number(),
  omittedFiles: z.number(),
  bytes: z.number(),
  selected: z.array(z.string()),
  directories: z.array(z.object({ path: z.string(), files: z.number() })),
});
export type ContextSummary = z.infer<typeof contextSummarySchema>;
/**
 * The inventory of one commit (optionally under a subtree). `digest` hashes the raw `ls-tree` output, so it
 * changes with any path, mode, blob or size; `directories` counts files per top-level directory, largest
 * first and bounded.
 */
export interface PinnedRepository {
  entries: RepositoryEntry[];
  byPath: Map<string, RepositoryEntry>;
  totalBytes: number;
  digest: string;
  directories: ContextSummary['directories'];
}
// Commit trees are immutable. Cache metadata only, never mutable worktree bytes.
// Bound memory as well as entry count; a large tree must not multiply per poll.
const cache = new Map<string, { tree: PinnedRepository; bytes: number }>();
let cachedBytes = 0;
/**
 * The inventory of commit `base` in `repo`, from the cache when possible. Only a full commit id is
 * accepted, so a cached inventory can never describe a moved ref.
 *
 * @throws Error when `base` is not a full commit id, the subtree is invalid, the tree contains a symlink,
 *   submodule or non-UTF-8 path, or Git fails.
 */
export function pinnedRepository(repo: string, base: string, subtree = ''): PinnedRepository {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Repository context requires a pinned commit');
  if (subtree.includes('\0') || subtree.split('/').some(part => part === '..'))
    throw new Error('Invalid repository subtree');
  const key = `${repo}\0${base}\0${subtree}`,
    found = cache.get(key);
  if (found) {
    // Re-insert so Map order stays least recently used first for eviction.
    cache.delete(key);
    cache.set(key, found);
    return found.tree;
  }
  const raw = deliveryGit(repo, 'ls-tree', '-r', '-l', '-z', base, ...(subtree ? ['--', subtree] : []));
  const directories = new Map<string, number>();
  let totalBytes = 0;
  const entries = raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const [, oid, size, path] = /^(?:100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry) ?? [];
      if (!oid || !size || !path)
        throw new Error('Repository context requires regular files; symlinks and submodules are unsupported');
      if (path.includes('\ufffd')) throw new Error('Repository paths must be valid UTF-8');
      const bytes = Number(size);
      totalBytes += bytes;
      const directory = path.includes('/') ? path.slice(0, path.indexOf('/')) + '/' : '(root)';
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
      return { path, oid, bytes };
    });
  const tree: PinnedRepository = {
    entries,
    byPath: new Map(entries.map(entry => [entry.path, entry])),
    totalBytes,
    digest: createHash('sha256').update(raw).digest('hex'),
    directories: [...directories]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, repositoryLimits.summaryDirectories)
      .map(([path, files]) => ({ path, files })),
  };
  // A rough allowance for the parsed entries and maps built from the raw listing.
  const bytes = raw.length * 4;
  while (
    cache.size &&
    (cache.size >= repositoryLimits.cacheEntries || cachedBytes + bytes > repositoryLimits.cacheBytes)
  ) {
    const [oldest, entry] = cache.entries().next().value ?? [];
    if (oldest === undefined || !entry) break;
    cachedBytes -= entry.bytes;
    cache.delete(oldest);
  }
  if (bytes <= repositoryLimits.cacheBytes) {
    cache.set(key, { tree, bytes });
    cachedBytes += bytes;
  }
  return tree;
}

/** Context file selections come from plans and dashboard forms; only distinct exact paths are accepted. */
const contextPathsSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine(path => !path.includes('\0')),
  )
  .max(contextLimits.files)
  .refine(paths => new Set(paths).size === paths.length);
/**
 * Validate a context file selection.
 *
 * @throws Error unless it is at most `contextLimits.files` distinct, non-empty paths.
 */
export function contextPaths(value: unknown): string[] {
  const parsed = contextPathsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Context files must be at most ${contextLimits.files} distinct exact repository paths`);
  return parsed.data;
}
/**
 * File names the pinned providers load as repository instructions in any directory. Codex reads
 * `AGENTS.override.md` in place of `AGENTS.md`; Claude adds the usually ignored `CLAUDE.local.md`.
 */
export const instructionFileNames: readonly string[] = [
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
];
/** Whether a path is a repository instruction file ({@link instructionFileNames} in any directory). */
export const instructionPath = (path: string) => instructionFileNames.includes(basename(path));

/**
 * What a planner was shown of `tree`. `digest` binds the inventory to the exact selection, so a reply can
 * be checked against the context it was drawn from.
 */
export function summarizeContext(tree: PinnedRepository, selected: string[], bytes: number): ContextSummary {
  return {
    inventoryDigest: tree.digest,
    digest: createHash('sha256')
      .update(JSON.stringify({ inventory: tree.digest, selected }))
      .digest('hex'),
    totalFiles: tree.entries.length,
    totalBytes: tree.totalBytes,
    includedFiles: selected.length,
    omittedFiles: tree.entries.length - selected.filter(path => tree.byPath.has(path)).length,
    bytes,
    selected,
    directories: tree.directories,
  };
}

/**
 * The planner context for a pinned commit: every instruction file plus an explicit selection, or without
 * one a scored, explicitly partial suggestion drawn from words in `request`. One batch for selected blobs.
 * No Git process or filesystem traversal per file.
 *
 * Suggested files that do not fit the budget or are not UTF-8 text are skipped.
 *
 * @throws Error when an explicit path is absent from the commit, or an instruction or explicitly selected
 *   file exceeds the budget or is not UTF-8 text, or the blob response is malformed.
 */
export function pinnedContext(repo: string, base: string, selection?: unknown, request = '') {
  const tree = pinnedRepository(repo, base),
    explicit = selection !== undefined;
  const required = tree.entries.filter(entry => instructionPath(entry.path));
  const requested = explicit
    ? contextPaths(selection).map(path => {
        const entry = tree.byPath.get(path);
        if (!entry) throw new Error(`Context file is absent from the pinned commit: ${path}`);
        return entry;
      })
    : suggestedEntries(tree, request);
  const chosen: RepositoryEntry[] = [],
    seen = new Set<string>();
  let bytes = 0;
  for (const entry of [...required, ...requested]) {
    if (seen.has(entry.path)) continue;
    const mandatory = explicit || instructionPath(entry.path);
    if (
      entry.bytes > contextLimits.fileBytes ||
      bytes + entry.bytes > contextLimits.bytes ||
      chosen.length >= contextLimits.files
    ) {
      if (mandatory) throw new Error(`Selected context exceeds its budget at ${entry.path}. ${contextBudget}`);
      continue;
    }
    chosen.push(entry);
    seen.add(entry.path);
    bytes += entry.bytes;
  }
  let encoded = 0;
  const files: { path: string; content: string }[] = [];
  for (const { entry, data } of pinnedBlobs(repo, chosen)) {
    const mandatory = explicit || instructionPath(entry.path);
    if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) {
      if (mandatory) throw new Error(`Selected context file must be UTF-8 text: ${entry.path}`);
      continue;
    }
    const file = { path: entry.path, content: data.toString('utf8') };
    // The budget is what the prompt carries, so escaping counts; raw sizes above only pre-filter.
    const itemBytes = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (encoded + itemBytes > contextLimits.bytes) {
      if (mandatory) throw new Error(`Selected context exceeds its budget at ${entry.path}. ${contextBudget}`);
      continue;
    }
    encoded += itemBytes;
    files.push(file);
  }
  return {
    files,
    summary: summarizeContext(
      tree,
      files.map(file => file.path),
      files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    ),
  };
}

/**
 * The bytes of `entries`, read in one `cat-file --batch` call.
 *
 * @throws Error when the blob response is malformed or incomplete.
 */
function pinnedBlobs(repo: string, entries: RepositoryEntry[]): { entry: RepositoryEntry; data: Buffer }[] {
  if (!entries.length) return [];
  const blobs = deliveryGitInput(
    repo,
    Buffer.from(entries.map(entry => `${entry.oid}\n`).join('')),
    'cat-file',
    '--batch',
  );
  let offset = 0;
  return entries.map(entry => {
    const end = blobs.indexOf(10, offset);
    if (end < 0 || blobs.subarray(offset, end).toString('ascii') !== `${entry.oid} blob ${entry.bytes}`)
      throw new Error('Pinned context blob response is invalid');
    offset = end + 1;
    const data = blobs.subarray(offset, offset + entry.bytes);
    offset += entry.bytes;
    if (data.length !== entry.bytes || blobs[offset++] !== 10)
      throw new Error('Pinned context blob response is incomplete');
    return { entry, data };
  });
}

function suggestedEntries(tree: PinnedRepository, request: string): RepositoryEntry[] {
  // Suggestions are explicitly partial, not a claim that dependencies were analysed.
  const terms = [...new Set(request.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])]
    .filter(term => !['the', 'and', 'with', 'this', 'that', 'for', 'from', 'should', 'change', 'file'].includes(term))
    .slice(0, 32);
  return tree.entries
    .map((entry, index) => {
      const path = entry.path.toLowerCase(),
        name = basename(path);
      const score =
        terms.reduce((sum, term) => sum + (path.includes(term) ? 20 : 0), 0) +
        (/^(readme(?:\.[^/]+)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json|makefile)$/i.test(
          entry.path,
        )
          ? 30
          : 0) +
        (/\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|rb|php|vue|svelte|html|css|json|md|toml|ya?ml)$/i.test(name) ? 2 : 0) -
        (/lock|generated|vendor|dist\/|build\//.test(path) ? 40 : 0);
      return { entry, score, index };
    })
    .filter(item => item.score >= 0 && item.entry.bytes <= contextLimits.fileBytes)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, repositoryLimits.suggestedFiles)
    .map(item => item.entry);
}

/**
 * One page of the pinned inventory whose paths contain every whitespace-separated word of `query`
 * (case-insensitive), with the inventory digest so a page can be tied to its commit.
 *
 * @throws Error for an invalid offset or an over-long or non-string query.
 */
export function searchPinnedFiles(repo: string, base: string, query = '', offset = 0) {
  const tree = pinnedRepository(repo, base);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof query !== 'string' ||
    query.length > repositoryLimits.searchQueryCharacters
  )
    throw new Error('Invalid repository search');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0;
  const files: RepositoryEntry[] = [];
  for (const entry of tree.entries)
    if (words.every(word => entry.path.toLowerCase().includes(word))) {
      if (matches >= offset && files.length < repositoryLimits.searchPage) files.push(entry);
      matches++;
    }
  return {
    files,
    matches,
    offset,
    nextOffset: offset + files.length < matches ? offset + files.length : null,
    inventoryDigest: tree.digest,
  };
}
