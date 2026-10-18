import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Read installed package source without giving agents shell or filesystem-wide access. */
export function readInstalledDependency(repo: string, input: Record<string, unknown>) {
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
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === name) {
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
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
    throw new Error('Dependency source must be a regular text file up to 4 MiB');
  const bytes = readFileSync(file),
    text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('Dependency source is not UTF-8 text');
  const offset = input.offset ?? 0,
    limit = input.limit ?? 12000;
  if (
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    !Number.isSafeInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 12000
  )
    throw new Error('Invalid dependency read offset or limit');
  const info = JSON.parse(readFileSync(manifest, 'utf8'));
  const identity = {
    package: name,
    version: info.version,
    path,
    resolvedPath: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (input.query !== undefined) {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256)
      throw new Error('Dependency search requires 1–256 literal characters');
    const source = text.toLowerCase(),
      query = input.query.toLowerCase(),
      matches: { offset: number; content: string }[] = [];
    let cursor = Number(offset),
      found: number;
    while (matches.length < 10 && (found = source.indexOf(query, cursor)) >= 0) {
      matches.push({ offset: found, content: text.slice(Math.max(0, found - 160), found + query.length + 160) });
      cursor = found + query.length;
    }
    return { ...identity, query: input.query, matches, nextOffset: source.indexOf(query, cursor) >= 0 ? cursor : null };
  }
  return {
    ...identity,
    content: text.slice(Number(offset), Number(offset) + Number(limit)),
    nextOffset: Number(offset) + Number(limit) < text.length ? Number(offset) + Number(limit) : null,
    totalCharacters: text.length,
    note: 'Installed dependency source; read hash is retained, but this is not repository validation evidence.',
  };
}
