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

/** Read installed package source without giving agents shell or filesystem-wide access. */
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
  const within = (base: string, file: string) => {
    const part = relative(base, file);
    return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
  };
  for (const part of [path, from])
    if (
      isAbsolute(part) ||
      part.includes('\\') ||
      part.includes('\0') ||
      part.split('/').some(value => value === '..' || /^\.(?:git|env|npmrc|grampus)/i.test(value))
    )
      throw new Error('Dependency reads require ordinary relative paths');
  const origin = realpathSync.native(resolve(root, from));
  if (!within(root, origin) || !statSync(origin).isDirectory() || from.split('/').includes('node_modules'))
    throw new Error('Importing directory must be inside the task repository');
  const require = createRequire(join(origin, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    let directory = dirname(require.resolve(name));
    while (true) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate) && readManifest(candidate).name === name) {
        manifest = candidate;
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Cannot locate the installed package manifest');
      directory = parent;
    }
  }
  const packageRoot = realpathSync.native(dirname(manifest));
  const file = realpathSync.native(resolve(packageRoot, path));
  if (!within(root, packageRoot) || !within(packageRoot, file))
    throw new Error('Dependency source must resolve inside this repository and package');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > limits.dependencyFileBytes)
    throw new Error(`Dependency source must be a regular text file up to ${formatBytes(limits.dependencyFileBytes)}`);
  const bytes = readFileSync(file),
    text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('Dependency source is not UTF-8 text');
  const range = rangeSchema.safeParse({ offset: input.offset, limit: input.limit });
  if (!range.success) throw new Error('Invalid dependency read offset or limit');
  const { offset, limit } = range.data;
  const info = readManifest(manifest);
  const identity = {
    package: name,
    version: info.version,
    path,
    resolvedPath: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (input.query !== undefined) {
    const literal = querySchema.safeParse(input.query);
    if (!literal.success)
      throw new Error(`Dependency search requires 1–${limits.dependencyQueryCharacters} literal characters`);
    const source = text.toLowerCase(),
      query = literal.data.toLowerCase(),
      matches: { offset: number; content: string }[] = [];
    let cursor = offset,
      found: number;
    const context = limits.dependencySnippetCharacters;
    while (matches.length < limits.dependencyMatches && (found = source.indexOf(query, cursor)) >= 0) {
      matches.push({
        offset: found,
        content: text.slice(Math.max(0, found - context), found + query.length + context),
      });
      cursor = found + query.length;
    }
    return {
      ...identity,
      query: literal.data,
      matches,
      nextOffset: source.indexOf(query, cursor) >= 0 ? cursor : null,
    };
  }
  return {
    ...identity,
    content: text.slice(offset, offset + limit),
    nextOffset: offset + limit < text.length ? offset + limit : null,
    totalCharacters: text.length,
    note: 'Installed dependency source; read hash is retained, but this is not repository validation evidence.',
  };
}
