// Orca's Node worker owns only native commands. Grampus owns process discovery, approvals and tasks.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function configuration(supplied) {
  const value = supplied ?? JSON.parse(readFileSync(new URL('./launch.json', import.meta.url), 'utf8'));
  if (
    value.schema !== 1 ||
    !isAbsolute(value.node) ||
    !isAbsolute(value.launcher) ||
    typeof value.orca !== 'string' ||
    !value.orca ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    !Number.isSafeInteger(value.outputBytes) ||
    value.outputBytes <= 0
  )
    throw new Error('Invalid Grampus plugin configuration; rebuild the plugin package.');
  return value;
}

function run(file, args, config, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: config.timeoutMs, maxBuffer: config.outputBytes, encoding: 'utf8', ...options },
      (error, stdout) => {
        // Raw stdout/stderr can contain a local access link. Errors stay separate from task outcomes.
        if (error)
          reject(new Error('Grampus command did not complete. Inspect its desktop log; no task was restarted.'));
        else resolve(stdout);
      },
    );
  });
}

/** Registers native commands. A worker reload never stops the independently owned dashboard. */
export default function activate(orca, supplied) {
  let pending = null;
  let pendingAction = null;
  function command(action) {
    if (pending) {
      if (action === pendingAction) return pending;
      return Promise.reject(new Error('Another Grampus command is still running. Wait for it to settle.'));
    }
    pendingAction = action;
    pending = (async () => {
      const config = configuration(supplied);
      const args = [config.launcher, action];
      if (action === 'open') args.push('--orca');
      const result = JSON.parse(
        await run(config.node, args, config, { env: { ...process.env, ORCA_CLI_COMMAND: config.orca } }),
      );
      if (result.ok !== true) throw new Error('Grampus did not confirm the command.');
      return result;
    })().finally(() => {
      pending = null;
      pendingAction = null;
    });
    return pending;
  }
  orca.commands.register('open', () => command('open'));
  orca.commands.register('stop', () => command('close'));
}
