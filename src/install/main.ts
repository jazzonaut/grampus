// `npm run install:local`: builds this checkout (the npm script runs the build first), installs it as a new
// version of the per-user installation and selects it. Windows only; macOS and Linux are Planned.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { installedDataDirectory } from '../config/paths.js';
import { loadSettings } from '../config/settings.js';
import { install, npmCli } from './install.js';
import { defaultInstallRoot, installLayout, packageRoot } from './installation.js';

const usage = `Usage: npm run install:local -- [--dirty] [--dir <folder>] [--no-path]

Installs this checkout as a new Grampus version and selects it.
  --dirty     install uncommitted changes (the build id is marked dirty)
  --dir       installation folder (default ${defaultInstallRoot()})
  --no-path   do not add the installation's bin folder to your PATH`;

function main(): number {
  const { values } = parseArgs({
    options: {
      dirty: { type: 'boolean' },
      dir: { type: 'string' },
      'no-path': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (process.platform !== 'win32')
    throw new Error('The installer supports Windows only; macOS and Linux are Planned.');
  const root = resolve(values.dir ?? defaultInstallRoot());
  const result = install({
    checkout: packageRoot,
    root,
    allowDirty: values.dirty ?? false,
    keep: loadSettings(installedDataDirectory()).keptVersions,
    now: new Date(),
    installDependencies,
    runCli,
    registerPath: values['no-path'] ? null : registerUserPath,
    log: line => console.log(line),
  });
  console.log(
    `\nInstalled Grampus ${result.build.build}${result.previous && result.previous !== result.build.build ? ` (was ${result.previous})` : ''}.`,
  );
  if (result.removed.length) console.log(`Removed old versions: ${result.removed.join(', ')}.`);
  warnAboutPath(installLayout(root).shim);
  return 0;
}

function installDependencies(versionDir: string): void {
  execFileSync(process.execPath, [npmCli(), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: versionDir,
    stdio: 'inherit',
    windowsHide: true,
  });
}

function runCli(cliPath: string, args: string[]): string {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${args.join(' ')} exited with ${result.status}`);
  return result.stdout;
}

/**
 * Add `bin` to the user's PATH unless it is there, keeping the other entries unexpanded (setx would expand
 * and truncate them), then tell running programs the environment changed.
 */
function registerUserPath(bin: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$bin = $env:GRAMPUS_INSTALL_BIN
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$present = @($userPath -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim().TrimEnd('\\') -ieq $bin.TrimEnd('\\') }).Count -gt 0
if (-not $present) {
  $updated = if ([string]::IsNullOrEmpty($userPath)) { $bin } else { $userPath.TrimEnd(';') + ';' + $bin }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  Write-Output 'added'
}`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, GRAMPUS_INSTALL_BIN: bin },
    windowsHide: true,
  });
  if (output.includes('added'))
    console.log(`Added ${bin} to your PATH. Restart Orca and open new terminals so they find \`grampus\`.`);
}

/** Point out other `grampus` commands on this process's PATH, such as an `npm link` from a checkout. */
function warnAboutPath(shim: string): void {
  const found = spawnSync('where.exe', ['grampus'], { encoding: 'utf8', windowsHide: true });
  const others = found.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && resolve(line).toLowerCase() !== shim.toLowerCase());
  if (!others.length) return;
  console.log(`Other \`grampus\` commands are on your PATH:\n${others.map(path => `  ${path}`).join('\n')}`);
  console.log(
    'Remove them (an `npm link` is removed with `npm unlink -g grampus`) so `grampus` always runs this install.',
  );
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
