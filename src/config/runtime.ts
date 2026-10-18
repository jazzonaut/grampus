import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const applicationVersion = (
  JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as { version: string }
).version;
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
const buildFile = join(applicationRoot, 'grampus-build.json');
export const installedBuild: BuildInfo | null = existsSync(buildFile)
  ? (JSON.parse(readFileSync(buildFile, 'utf8')) as BuildInfo)
  : null;
export const applicationChannel = installedBuild ? 'installed' : 'development';
/** Built-in dashboard port; `dashboardPort` in config.json overrides it (see settings.ts). */
export const defaultDashboardPort = installedBuild ? 4317 : 4318;

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

/** `dashboardPort` is the effective port; callers with loaded settings pass `currentSettings().dashboardPort`. */
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

/** An update is explicit: run the checkout's installer, without fetching or changing its Git state. */
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
