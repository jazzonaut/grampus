// Locates the data directory. It holds config.json and one folder per task. The directory is separate
// from the data of earlier Grampus versions, which this version never reads.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The data directory: `GRAMPUS_HOME`, or a per-user folder named after the platform's conventions. */
export function dataDirectory(): string {
  if (process.env.GRAMPUS_HOME) return resolve(process.env.GRAMPUS_HOME);
  const base =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Grampus')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Grampus')
        : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'grampus');
  return join(base, 'orca');
}
