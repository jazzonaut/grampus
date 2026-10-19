// Owns reads of installed dependency source for the grampus_read_dependency tool: package resolution
// from an importing directory, bounded paging and literal search, never outside the task repository.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { formatBytes, repositoryToolLimits } from '../config/limits.js';
import { parseBoundary, parseJson } from '../process/boundary.js';
import type { ReadDependencyArguments } from './repository-tool-arguments.js';

const limits = repositoryToolLimits;
const rangeSchema = z.object({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(limits.pageCharacters).default(limits.pageCharacters),
});
const querySchema = z
  .string()
  .max(limits.dependencyQueryCharacters)
  .refine(value => value.trim() !== '');

/** The `package.json` fields read here; other fields of an installed manifest are not trusted or used. */
const manifestSchema = z.looseObject({ name: z.unknown().optional(), version: z.unknown().optional() });
function readManifest(path: string) {
  const context = { kind: 'configuration', source: path } as const;
  return parseBoundary(manifestSchema, parseJson(readFileSync(path, 'utf8'), context), context);
}

/** Whether `file` is `base` or inside it. */
function within(base: string, file: string): boolean {
  const part = relative(base, file);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

/** Throws unless every path is relative, forward-slashed and avoids parent, VCS, secret and controller files. */
function requireOrdinaryPaths(...parts: string[]): void {
  for (const part of parts)
    if (
      isAbsolute(part) ||
      part.includes('\\') ||
      part.includes('\0') ||
      part.split('/').some(value => value === '..' || /^\.(?:git|env|npmrc|grampus)/i.test(value))
    )
      throw new Error('Dependency reads require ordinary relative paths');
}

/**
 * The manifest of `name` as Node would resolve it from the importing directory. Packages whose
 * `exports` hide `package.json` are found by walking up from the resolved entry point to the manifest
 * that names the package.
 */
function packageManifest(require: NodeJS.Require, name: string): string {
  try {
    return require.resolve(`${name}/package.json`);
  } catch {
    let directory = dirname(require.resolve(name));
    for (;;) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate) && readManifest(candidate).name === name) return candidate;
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Cannot locate the installed package manifest');
      directory = parent;
    }
  }
}

/** The bytes and text of a regular, bounded UTF-8 file. */
function dependencySource(file: string): { bytes: Buffer; text: string } {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > limits.dependencyFileBytes)
    throw new Error(`Dependency source must be a regular text file up to ${formatBytes(limits.dependencyFileBytes)}`);
  const bytes = readFileSync(file),
    text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('Dependency source is not UTF-8 text');
  return { bytes, text };
}

/** Case-insensitive literal matches from `offset`, each with surrounding context, and where to continue. */
function searchSource(text: string, query: unknown, offset: number) {
  const literal = querySchema.safeParse(query);
  if (!literal.success)
    throw new Error(`Dependency search requires 1–${limits.dependencyQueryCharacters} literal characters`);
  const source = text.toLowerCase(),
    needle = literal.data.toLowerCase(),
    matches: { offset: number; content: string }[] = [];
  let cursor = offset,
    found: number;
  const context = limits.dependencySnippetCharacters;
  while (matches.length < limits.dependencyMatches && (found = source.indexOf(needle, cursor)) >= 0) {
    matches.push({
      offset: found,
      content: text.slice(Math.max(0, found - context), found + needle.length + context),
    });
    cursor = found + needle.length;
  }
  return { query: literal.data, matches, nextOffset: source.indexOf(needle, cursor) >= 0 ? cursor : null };
}

/**
 * Reads (or searches) one file of an installed package without giving agents shell or filesystem-wide
 * access: the package is resolved from a directory inside the task repository, and both the package
 * and the file must resolve inside the repository. The result names the version and content hash so a
 * reply can say exactly what it read; it is never validation evidence.
 *
 * @throws Error, returned to the agent as the tool error, for an invalid package name or path, an importing
 *   directory outside the repository or inside `node_modules`, a package or file that resolves elsewhere,
 *   a non-UTF-8 or oversized file, or an invalid range or query.
 */
export function readInstalledDependency(repo: string, input: ReadDependencyArguments) {
  const name = input.package,
    path = input.path ?? 'package.json',
    from = input.from ?? '.';
  if (
    typeof name !== 'string' ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
    typeof path !== 'string' ||
    typeof from !== 'string'
  )
    throw new Error('Supply an installed package name, relative file path and optional importing directory');
  const root = realpathSync.native(repo);
  requireOrdinaryPaths(path, from);
  const origin = realpathSync.native(resolve(root, from));
  if (!within(root, origin) || !statSync(origin).isDirectory() || from.split('/').includes('node_modules'))
    throw new Error('Importing directory must be inside the task repository');
  const manifest = packageManifest(createRequire(join(origin, 'package.json')), name);
  const packageRoot = realpathSync.native(dirname(manifest));
  const file = realpathSync.native(resolve(packageRoot, path));
  if (!within(root, packageRoot) || !within(packageRoot, file))
    throw new Error('Dependency source must resolve inside this repository and package');
  const { bytes, text } = dependencySource(file);
  const range = rangeSchema.safeParse({ offset: input.offset, limit: input.limit });
  if (!range.success) throw new Error('Invalid dependency read offset or limit');
  const { offset, limit } = range.data;
  const identity = {
    package: name,
    version: readManifest(manifest).version,
    path,
    resolvedPath: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (input.query !== undefined) return { ...identity, ...searchSource(text, input.query, offset) };
  return {
    ...identity,
    content: text.slice(offset, offset + limit),
    nextOffset: offset + limit < text.length ? offset + limit : null,
    totalCharacters: text.length,
    note: 'Installed dependency source; read hash is retained, but this is not repository validation evidence.',
  };
}
