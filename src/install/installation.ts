// What a Grampus installation looks like on disk, and which build this process runs. An installation is a
// folder with `bin/` (the `grampus` command on PATH), `current.json` (the selected build) and one immutable
// folder per build under `versions/`. A version folder holds `build.json`; a development checkout does
// not, which is how a process tells whether it is installed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** The package root of the running code: a development checkout, or one installed version folder. */
export const packageRoot = join(import.meta.dirname, '..', '..', '..');

/**
 * A build id: the package version, then semver build metadata (`0.10.0+a1daeb8c3f21`, with
 * `.dirty.<time>` for an uncommitted tree). It names a folder, so it starts with a digit and has no
 * separators: `..` or a path can never be selected.
 */
export const buildIdPattern = /^\d[0-9A-Za-z.+-]*$/;

/** Characters of the commit SHA in a build id. */
const shortShaLength = 12;

const buildInfoSchema = z
  .object({
    version: z.string().min(1),
    build: z.string().regex(buildIdPattern),
    commit: z.string().min(1),
    /** Built from a working tree with uncommitted changes. */
    dirty: z.boolean(),
    builtAt: z.string().min(1),
    /** The checkout it was built from. */
    source: z.string().min(1),
  })
  .strict();

/** The identity of one installed build, recorded in its version folder's `build.json`. */
export type BuildInfo = z.infer<typeof buildInfoSchema>;

/** The build an installed version folder holds, or null for a development checkout. */
export function installedBuild(root: string = packageRoot): BuildInfo | null {
  const path = join(root, 'build.json');
  if (!existsSync(path)) return null;
  return buildInfoSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The `version` in a package root's package.json. */
export function packageVersion(root: string = packageRoot): string {
  const parsed = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  return parsed.version;
}

/** The build id for a commit; `dirtyAt` marks a build of uncommitted changes with the time it was made. */
export function buildId(version: string, commit: string, dirtyAt: Date | null): string {
  const base = `${version}+${commit.slice(0, shortShaLength)}`;
  if (!dirtyAt) return base;
  return `${base}.dirty.${dirtyAt
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
}

/** The default installation folder: `%LOCALAPPDATA%\Programs\Grampus`, where per-user Windows apps live. */
export function defaultInstallRoot(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Grampus');
}

/** Paths inside one installation. */
export interface InstallLayout {
  root: string;
  bin: string;
  /** `bin/launch.mjs`: runs the selected build. */
  launcher: string;
  /** `bin/grampus.cmd`: the command on PATH. */
  shim: string;
  /** `current.json`: `{ "build": "<build id>" }`. */
  current: string;
  /** `grampus-install.json`: marks the folder as a Grampus installation. */
  marker: string;
  versions: string;
  lock: string;
}

export function installLayout(root: string): InstallLayout {
  const bin = join(root, 'bin');
  return {
    root,
    bin,
    launcher: join(bin, 'launch.mjs'),
    shim: join(bin, 'grampus.cmd'),
    current: join(root, 'current.json'),
    marker: join(root, 'grampus-install.json'),
    versions: join(root, 'versions'),
    lock: join(root, 'install.lock'),
  };
}

/** The installation that holds a version folder (`<root>/versions/<build>`). */
export function installationOf(versionRoot: string): string {
  return dirname(dirname(versionRoot));
}

/** The build `current.json` selects, or null when nothing is selected yet. */
export function selectedBuild(root: string): string | null {
  const path = installLayout(root).current;
  if (!existsSync(path)) return null;
  const { build } = z.object({ build: z.string().regex(buildIdPattern) }).parse(JSON.parse(readFileSync(path, 'utf8')));
  return build;
}

/**
 * The script that runs this Grampus: the installation's launcher for an installed build, so a driver
 * restarted after an update runs the newly selected build; the checkout's compiled CLI otherwise.
 */
export function entryScript(): string {
  return installedBuild()
    ? installLayout(installationOf(packageRoot)).launcher
    : join(packageRoot, 'dist', 'src', 'cli.js');
}

/**
 * `bin/launch.mjs`. It reads `current.json` on every start and imports that build's CLI, so an install
 * changes what the next command runs and never what a running process already loaded.
 */
export const launcherScript = `// Written by the Grampus installer; every install rewrites it. Runs the build current.json selects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Grampus needs Node.js 24 or later on PATH.');
  const { build } = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
  if (typeof build !== 'string' || !${String(buildIdPattern)}.test(build))
    throw new Error('No valid Grampus build is selected in ' + join(root, 'current.json') + '; reinstall Grampus.');
  await import(pathToFileURL(join(root, 'versions', build, 'dist', 'src', 'cli.js')).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

/** `bin/grampus.cmd`. Delayed expansion stays off so `!` in a request reaches Grampus unchanged. */
export const shimScript =
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode "%~dp0launch.mjs" %*\r\nexit /b %errorlevel%\r\n';
