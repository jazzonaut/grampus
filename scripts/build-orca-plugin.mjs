// Packages a machine-local Orca command plugin. It never installs/enables a plugin or changes Grampus.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Produces a local package pinned to this checkout, or an explicitly selected installed launcher. */
export async function buildOrcaPlugin({ destination = join(root, '.grampus', 'orca-plugin'), installed } = {}) {
  const { orcaExecutable } = await import('../dist/src/repository/orca.js');
  const { currentSettings } = await import('../dist/src/config/settings.js');
  const { processLimits } = await import('../dist/src/config/limits.js');
  const launcher = installed ? join(resolve(installed), 'bin', 'launch.mjs') : join(root, 'dist', 'src', 'cli.js');
  if (!existsSync(join(root, 'dist', 'src', 'cli.js')) || !existsSync(join(root, 'web', 'dist', 'index.html')))
    throw new Error('Build Grampus and its dashboard before packaging the Orca plugin.');
  mkdirSync(destination, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'plugins', 'orca', 'orca-plugin.json'), 'utf8'));
  if (!installed) {
    manifest.id = 'grampus-dev';
    manifest.name = 'Grampus Development';
    for (const command of manifest.contributes.commands)
      command.title = command.title.replace('Grampus:', 'Grampus Development:');
  }
  writeFileSync(join(destination, 'orca-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  copyFileSync(join(root, 'plugins', 'orca', installed ? 'installed.mjs' : 'main.mjs'), join(destination, 'main.mjs'));
  writeFileSync(
    join(destination, 'launch.json'),
    JSON.stringify(
      {
        schema: 1,
        ...(installed ? { installation: resolve(installed) } : {}),
        node: process.execPath,
        launcher,
        orca: orcaExecutable(),
        timeoutMs: currentSettings().dashboardStartupMs + processLimits.orcaTimeoutMs,
        outputBytes: processLimits.toolOutputBytes,
      },
      null,
      2,
    ) + '\n',
  );
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { installed: { type: 'string' }, out: { type: 'string' } } });
  console.log(
    await buildOrcaPlugin({
      ...(values.installed ? { installed: values.installed } : {}),
      ...(values.out ? { destination: resolve(values.out) } : {}),
    }),
  );
}
