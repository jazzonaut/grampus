// Owns the visibility check shared by native creations and reads of newly created scoped files.
import { spawnSync } from 'node:child_process';
import { processLimits } from '../config/limits.js';

/** Refuses ignored or unobservable paths: a file outside snapshot coverage cannot become task evidence. */
export function requireSnapshotVisible(cwd: string, path: string): void {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const result = spawnSync('git', ['--no-optional-locks', '-C', cwd, 'check-ignore', '--no-index', '-q', '--', path], {
    env,
    windowsHide: true,
    timeout: processLimits.gitTimeoutMs,
    stdio: 'pipe',
  });
  if (result.error || result.status !== 1)
    throw new Error('Creation paths must be visible to repository snapshots, not ignored');
}
