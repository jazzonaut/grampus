// Owns where and what this copy of Grampus is: its root, version, installed or development channel,
// default data directory and the explicit update command. It never reads the journal or config.json,
// and the data directory keeps a development checkout apart from the installed application.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Node built-ins only, no package imports: this module must load on its own, without the snapshot
// dependencies (test/installation.test.ts stages it alone to check versions and channels).

/** The parsed JSON object in `path`, or a thrown error naming the file when it is not an object. */
function jsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} must contain a JSON object`);
  return Object.fromEntries(Object.entries(value));
}

/** The checkout or installation root: three levels above this compiled module (`dist/src/config`). */
export const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** The `package.json` version; read when the module loads, so a missing or malformed file throws on import. */
export const applicationVersion = ((): string => {
  const version = jsonObject(join(applicationRoot, 'package.json'))['version'];
  if (typeof version !== 'string') throw new Error('package.json has no version');
  return version;
})();

/** What `scripts/install.mjs` records about an installed build; absent in a development checkout. */
export interface BuildInfo {
  id: string;
  version: string;
  commit: string | null;
  dirty: boolean;
  sourceDigest: string;
  builtAt: string;
  source: string;
  installRoot: string;
}

/** Validates a build record field by field; throws naming the file when one is missing or mistyped. */
function buildInfo(path: string): BuildInfo {
  const record = jsonObject(path);
  const text = (key: keyof BuildInfo): string => {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`${path}: ${key} must be text`);
    return value;
  };
  const commit = record['commit'];
  const dirty = record['dirty'];
  if ((commit !== null && typeof commit !== 'string') || typeof dirty !== 'boolean')
    throw new Error(`${path}: commit must be text or null and dirty a boolean`);
  return {
    id: text('id'),
    version: text('version'),
    commit,
    dirty,
    sourceDigest: text('sourceDigest'),
    builtAt: text('builtAt'),
    source: text('source'),
    installRoot: text('installRoot'),
  };
}
const buildFile = join(applicationRoot, 'grampus-build.json');
/** The installed build record, or null in a development checkout. A malformed record throws on import. */
export const installedBuild: BuildInfo | null = existsSync(buildFile) ? buildInfo(buildFile) : null;
/** `installed` when a build record is present, otherwise `development`. */
export const applicationChannel = installedBuild ? 'installed' : 'development';
/** Built-in dashboard port; `dashboardPort` in config.json overrides it (see settings.ts). */
export const defaultDashboardPort = installedBuild ? 4317 : 4318;

/**
 * The data directory (journal, settings and check logs): `GRAMPUS_HOME` when set, otherwise a per-user
 * platform location. Each development checkout gets its own subdirectory, keyed by a digest of its
 * root (lower-cased on Windows, where paths are case-insensitive), so development work never opens
 * the installed application's journal or another checkout's.
 */
export function defaultDataDirectory(): string {
  if (process.env.GRAMPUS_HOME) return resolve(process.env.GRAMPUS_HOME);
  const base =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Grampus')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Grampus')
        : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'grampus');
  const checkout = createHash('sha256')
    .update(process.platform === 'win32' ? applicationRoot.toLowerCase() : applicationRoot)
    .digest('hex')
    .slice(0, 12);
  return installedBuild ? join(base, 'installed') : join(base, 'development', checkout);
}

/**
 * What `grampus version` and the dashboard report about this copy. `dashboardPort` is the effective
 * port; callers with loaded settings pass `currentSettings().dashboardPort`.
 */
export function versionInformation(dashboardPort = defaultDashboardPort) {
  return {
    version: applicationVersion,
    channel: applicationChannel,
    build: installedBuild,
    applicationRoot,
    dataDirectory: defaultDataDirectory(),
    dashboardPort,
    node: process.version,
    nodeExecutable: process.execPath,
  };
}

export function versionLabel(): string {
  return `Grampus ${applicationVersion} (${applicationChannel}${installedBuild ? `, build ${installedBuild.id}` : ''})`;
}

/**
 * An update is explicit: run the checkout's installer, without fetching or changing its Git state.
 * Throws in a development checkout, when the source checkout has no installer, or when the installer
 * exits unsuccessfully.
 */
export async function updateInstallation(source?: string, yes = false): Promise<void> {
  if (!installedBuild) throw new Error('Run npm run install:local in the checkout to install Grampus first.');
  const checkout = resolve(source ?? installedBuild.source),
    installer = join(checkout, 'scripts', 'install.mjs');
  if (!existsSync(installer))
    throw new Error(`Update checkout not found: ${checkout}. Use grampus update --source <checkout>.`);
  const result = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [installer, '--dir', installedBuild.installRoot, ...(yes ? ['--yes'] : [])], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', done);
  });
  if (result !== 0)
    throw new Error(
      `Grampus update did not finish (${result ?? 'interrupted'}). The installer retains the previous selection until activation.`,
    );
}
