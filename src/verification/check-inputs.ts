// Owns reusable-check input fingerprints. Missing inputs, links, excessive inventories and changing
// files disable reuse; checking still runs normally. No environment values are persisted in clear text.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commandLimits } from '../config/limits.js';

/**
 * Hashes the executable, inherited environment, runtime, working directory and declared extra inputs.
 * The repository artifact and instructions are compared separately. Call only under the execution lease.
 */
export function checkInputFingerprint(cwd: string, file: string, inputs: readonly string[]): string | null {
  try {
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify([
        realpathSync.native(cwd),
        process.platform,
        process.arch,
        process.version,
        Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    );
    let files = 0,
      bytes = 0;
    const add = (path: string): void => {
      files++;
      if (files > commandLimits.reuseInputFiles) throw new Error('Input inventory budget');
      const before = lstatSync(path, { bigint: true });
      if (before.isSymbolicLink() || realpathSync.native(path) !== path) throw new Error('Aliased input');
      hash.update(JSON.stringify([path, before.mode.toString()]));
      if (before.isDirectory()) {
        for (const name of readdirSync(path).sort()) add(join(path, name));
        return;
      }
      if (!before.isFile() || before.nlink !== 1n) throw new Error('Non-regular input');
      bytes += Number(before.size);
      if (files > commandLimits.reuseInputFiles || bytes > commandLimits.reuseInputBytes)
        throw new Error('Input budget');
      const data = readFileSync(path);
      const after = lstatSync(path, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        throw new Error('Input changed during capture');
      hash.update(data);
    };
    // Version managers commonly expose an executable through a directory link. Bind both the
    // requested path and its resolved binary, so retargeting the link invalidates the fingerprint.
    const executable = realpathSync.native(resolve(file));
    hash.update(JSON.stringify([resolve(file), executable]));
    add(executable);
    for (const input of [...inputs].sort()) {
      const path = resolve(cwd, input);
      for (let parent = dirname(path); parent !== cwd; parent = dirname(parent)) {
        if (dirname(parent) === parent || lstatSync(parent).isSymbolicLink())
          throw new Error('Input outside workspace');
      }
      add(path);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
