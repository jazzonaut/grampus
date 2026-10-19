// The installed Orca package follows Grampus's atomic version selection, even if Orca copies the folder.
// Only the selected immutable snapshot supplies command behaviour; an incomplete update is never used.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Registers stable commands which resolve the selected installed worker at invocation time. */
export default function activate(orca) {
  const workers = new Map();
  async function command(name) {
    const config = JSON.parse(readFileSync(new URL('./launch.json', import.meta.url), 'utf8'));
    if (config.schema !== 1 || typeof config.installation !== 'string' || !isAbsolute(config.installation))
      throw new Error('Invalid Grampus plugin installation; reinstall its Orca package.');
    const selection = JSON.parse(readFileSync(join(config.installation, 'current.json'), 'utf8'));
    if (selection.schema !== 1 || typeof selection.release !== 'string' || !/^[a-zA-Z0-9-]+$/.test(selection.release))
      throw new Error('Invalid Grampus installation selection; rerun its installer.');
    const entry = join(config.installation, 'versions', selection.release, 'plugins', 'orca', 'main.mjs');
    let worker = workers.get(entry);
    if (!worker) {
      worker = import(pathToFileURL(entry).href).then(module => {
        const commands = new Map();
        module.default({ commands: { register: (id, handler) => commands.set(id, handler) } }, config);
        return commands;
      });
      workers.set(entry, worker);
    }
    const handler = (await worker).get(name);
    if (typeof handler !== 'function') throw new Error('The selected Grampus version does not provide this command.');
    return handler();
  }
  orca.commands.register('open', () => command('open'));
  orca.commands.register('stop', () => command('stop'));
}
