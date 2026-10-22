// Installs a built checkout as a new immutable version of a Grampus installation and selects it. The
// selection changes in one rename after the copy passed a smoke check, so `grampus` runs either the
// previous build or the new one, never a half-copied folder. Processes already running keep the code they
// loaded. Old versions are pruned, keeping the newest few.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  buildId,
  buildIdPattern,
  installedBuild,
  installLayout,
  launcherScript,
  packageVersion,
  selectedBuild,
  shimScript,
  type BuildInfo,
  type InstallLayout,
} from './installation.js';

/** Bumped when the installation layout changes; an installation with another layout is refused. */
const layoutVersion = 2;

const markerSchema = z.object({ application: z.literal('grampus'), layout: z.number() });

export interface InstallOptions {
  /** The checkout to install, already built (`dist/src`, `dist/web`). */
  checkout: string;
  /** The installation folder. */
  root: string;
  /** Install a working tree with uncommitted changes; its build id says so. */
  allowDirty: boolean;
  /** How many versions to keep, the selected one included. */
  keep: number;
  now: Date;
  /** Install production dependencies into a version folder. */
  installDependencies: (versionDir: string) => void;
  /** Run a version's CLI with arguments and return what it printed. */
  runCli: (cliPath: string, args: string[]) => string;
  /** Put the installation's `bin` on the user's PATH; null leaves PATH alone. */
  registerPath: ((bin: string) => void) | null;
  log: (line: string) => void;
}

export interface InstallResult {
  build: BuildInfo;
  /** The version folder already held this build, so it was selected again rather than copied. */
  reused: boolean;
  /** The build selected before this install. */
  previous: string | null;
  removed: string[];
}

/** npm's own CLI script: the one running this install, or the one beside Node. */
export function npmCli(): string {
  const candidate =
    process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(candidate)) throw new Error(`npm was not found at ${candidate}.`);
  return candidate;
}

/** Install the checkout's build and select it. Throws before changing the selection if anything fails. */
export function install(options: InstallOptions): InstallResult {
  const root = resolve(options.root);
  const layout = installLayout(root);
  const identity = describeCheckout(options.checkout, options.allowDirty, options.now);
  prepareRoot(root, options.checkout);
  const lock = acquireLock(layout.lock);
  try {
    const previous = selectedBuild(root);
    const versionDir = join(layout.versions, identity.build);
    const reused = existsSync(join(versionDir, 'build.json'));
    if (reused) options.log(`Version ${identity.build} is already installed; selecting it.`);
    else createVersion(options, versionDir, identity);
    smokeCheck(options, root, identity.build);
    writeLaunchers(layout);
    options.registerPath?.(layout.bin);
    replaceFile(layout.current, `${JSON.stringify({ build: identity.build })}\n`);
    options.log(options.runCli(join(versionDir, 'dist', 'src', 'cli.js'), ['skill', 'install']).trimEnd());
    const removed = pruneVersions(root, options.keep, options.log);
    return { build: identity, reused, previous, removed };
  } finally {
    releaseLock(lock, layout.lock);
  }
}

/** The build a checkout would install. A dirty tree is refused unless allowed. */
export function describeCheckout(checkout: string, allowDirty: boolean, now: Date): BuildInfo {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: checkout, encoding: 'utf8', windowsHide: true }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']) !== '';
  if (dirty && !allowDirty)
    throw new Error(
      'The checkout has uncommitted changes. Commit them, or pass --dirty to install them as a build marked dirty.',
    );
  const version = packageVersion(checkout);
  return {
    version,
    build: buildId(version, commit, dirty ? now : null),
    commit,
    dirty,
    builtAt: now.toISOString(),
    source: resolve(checkout),
  };
}

/** Create the folder, or check it is an installation with this layout. Never inside the checkout. */
function prepareRoot(root: string, checkout: string): void {
  const source = resolve(checkout);
  if (inside(root, source) || inside(source, root))
    throw new Error(`Install outside the checkout: ${root} and ${source} overlap.`);
  const { marker } = installLayout(root);
  if (existsSync(marker)) {
    const parsed = markerSchema.safeParse(JSON.parse(readFileSync(marker, 'utf8')));
    if (!parsed.success || parsed.data.layout !== layoutVersion)
      throw new Error(
        `${root} holds a Grampus installation with another layout. Remove the folder, then install again.`,
      );
    return;
  }
  if (existsSync(root) && readdirSync(root).length)
    throw new Error(`${root} is not empty and is not a Grampus installation. Choose another folder with --dir.`);
  mkdirSync(root, { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ application: 'grampus', layout: layoutVersion })}\n`, { flag: 'wx' });
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function acquireLock(path: string): number {
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return fd;
  } catch {
    throw new Error(`Another install may be running. Remove ${path} only after it has finished.`);
  }
}

function releaseLock(fd: number, path: string): void {
  closeSync(fd);
  unlinkSync(path);
}

/**
 * Copy what the CLI needs at run time and install its production dependencies. `build.json` is written
 * last: a folder without it is an interrupted install, which the next prune removes.
 */
function createVersion(options: InstallOptions, versionDir: string, identity: BuildInfo): void {
  const { checkout } = options;
  for (const required of ['dist/src/cli.js', 'dist/web/index.html', 'skills/grampus/SKILL.md'])
    if (!existsSync(join(checkout, required)))
      throw new Error(`The checkout has no ${required}. Run \`npm run build\` first.`);
  rmSync(versionDir, { recursive: true, force: true });
  options.log(`Copying ${identity.build} into ${versionDir}`);
  for (const path of ['package.json', 'package-lock.json', 'dist/src', 'dist/web', 'skills'])
    cpSync(join(checkout, path), join(versionDir, path), { recursive: true });
  try {
    options.log('Installing production dependencies');
    options.installDependencies(versionDir);
    writeFileSync(join(versionDir, 'build.json'), `${JSON.stringify(identity, null, 2)}\n`);
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
}

/** Run the version's CLI and check it reports the expected build. A failing copy is removed unless selected. */
function smokeCheck(options: InstallOptions, root: string, build: string): void {
  const versionDir = join(installLayout(root).versions, build);
  let reported: unknown;
  try {
    reported = JSON.parse(options.runCli(join(versionDir, 'dist', 'src', 'cli.js'), ['version', '--json']));
  } catch (error) {
    reported = error;
  }
  const parsed = z.object({ build: z.object({ build: z.string() }) }).safeParse(reported);
  if (parsed.success && parsed.data.build.build === build) return;
  if (selectedBuild(root) !== build) rmSync(versionDir, { recursive: true, force: true });
  const detail = reported instanceof Error ? `: ${reported.message}` : '.';
  throw new Error(`The installed copy of ${build} did not start correctly${detail} Nothing was changed.`);
}

/** Write the launcher and the PATH shim. They do not depend on the build, so every install rewrites them. */
function writeLaunchers(layout: InstallLayout): void {
  mkdirSync(layout.bin, { recursive: true });
  replaceFile(layout.launcher, launcherScript);
  replaceFile(layout.shim, shimScript);
}

/** Replace a file in one rename, so a reader sees the old content or the new, never part of it. */
function replaceFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/**
 * Keep the selected build and the newest others up to `keep` in all; remove the rest and any interrupted
 * install. A version that cannot be removed (a file still open) is kept and reported.
 */
export function pruneVersions(root: string, keep: number, log: (line: string) => void): string[] {
  const { versions } = installLayout(root);
  if (!existsSync(versions)) return [];
  const current = selectedBuild(root);
  const folders = readdirSync(versions, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && buildIdPattern.test(entry.name))
    .map(entry => ({ name: entry.name, build: installedBuild(join(versions, entry.name)) }));
  const complete = folders
    .flatMap(folder => (folder.build ? [{ name: folder.name, builtAt: folder.build.builtAt }] : []))
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  const kept = new Set(current ? [current] : []);
  for (const folder of complete) if (kept.size < keep) kept.add(folder.name);
  const removed: string[] = [];
  for (const folder of folders) {
    if (kept.has(folder.name)) continue;
    try {
      rmSync(join(versions, folder.name), { recursive: true, force: true });
      removed.push(folder.name);
    } catch (error) {
      log(`Kept ${folder.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}
