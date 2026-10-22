// `grampus update`: installs what is committed in the checkout the running build came from (or another
// one given with --from), by running that checkout's own `npm run install:local`. It never fetches or
// pulls: what a new version contains is decided by committing in the checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeCheckout, npmCli } from './install.js';
import type { BuildInfo } from './installation.js';

/** What an update would do: nothing, because the checkout holds the running build, or install a commit. */
export type UpdatePlan = { kind: 'current'; build: string } | { kind: 'install'; checkout: string; commit: string };

/** Compare the checkout with the running build. Refuses a missing or foreign folder, and a dirty tree unless allowed. */
export function planUpdate(build: BuildInfo, from: string | undefined, allowDirty: boolean): UpdatePlan {
  const checkout = resolve(from ?? build.source);
  if (!existsSync(checkout))
    throw new Error(`The checkout ${checkout} no longer exists. Pass --from <checkout> to update from another one.`);
  const manifest = join(checkout, 'package.json');
  if (!existsSync(manifest) || (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name !== 'grampus')
    throw new Error(`${checkout} is not a Grampus checkout.`);
  const next = describeCheckout(checkout, allowDirty, new Date());
  if (next.commit === build.commit && !next.dirty && !build.dirty) return { kind: 'current', build: build.build };
  return { kind: 'install', checkout, commit: next.commit };
}

/** Build and install the checkout through its own installer, showing its output. Returns its exit code. */
export function runInstaller(checkout: string, allowDirty: boolean): number {
  const args = [npmCli(), 'run', 'install:local', ...(allowDirty ? ['--', '--dirty'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: checkout, stdio: 'inherit', windowsHide: true });
  return result.status ?? 1;
}
