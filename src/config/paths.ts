// Locates the data directory. It holds config.json and one folder per task. An installed build and
// development runs from a checkout use separate folders, so a development build (which may write another
// event schema) never touches real tasks. Data of earlier Grampus versions is never read.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { installedBuild } from '../install/installation.js';

/** The data directory: `GRAMPUS_HOME`, or this build's default (installed or development). */
export function dataDirectory(): string {
  if (process.env.GRAMPUS_HOME) return resolve(process.env.GRAMPUS_HOME);
  return defaultDataDirectory(installedBuild() !== null);
}

/** The data directory an installed build uses: `GRAMPUS_HOME`, or its default. The installer reads its settings. */
export function installedDataDirectory(): string {
  return process.env.GRAMPUS_HOME ? resolve(process.env.GRAMPUS_HOME) : defaultDataDirectory(true);
}

/** The per-user default, named after the platform's conventions: `orca` when installed, `orca-dev` otherwise. */
export function defaultDataDirectory(installed: boolean): string {
  const base =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Grampus')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Grampus')
        : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'grampus');
  return join(base, installed ? 'orca' : 'orca-dev');
}
