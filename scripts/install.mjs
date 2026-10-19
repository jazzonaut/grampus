import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shim = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode "%~dp0launch.mjs" %*\r\nexit /b %errorlevel%\r\n';
const powershell = () =>
  resolve(process.env.SystemRoot ?? process.env.WINDIR ?? '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

export function requireNode(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+/.test(version) || Number(version.split('.')[0]) < 24)
    throw new Error(`Node.js 24 or later is required (found ${version}).`);
}

/** Check external prerequisites before creating any installation files. No inference or login prompts. */
export function checkDependencies() {
  if (process.platform !== 'win32') throw new Error('This installer currently supports Windows only.');
  requireNode();
  const checks = [],
    failures = [];
  const inspect = (name, action) => {
    try {
      const detail = action();
      checks.push({ name, detail });
    } catch {
      failures.push(name);
    }
  };
  inspect('Node.js with node:sqlite', () =>
    run(process.execPath, [
      '-e',
      "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close();console.log(process.version)",
    ]).trim(),
  );
  inspect('Windows PowerShell 5.1+', () =>
    run(powershell(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "if ($PSVersionTable.PSVersion -lt [Version]'5.1') { exit 1 }; $PSVersionTable.PSVersion.ToString()",
    ]).trim(),
  );
  let npmCli;
  inspect('npm', () => {
    npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli)) {
      const command = run(powershell(), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source",
      ]).trim();
      npmCli = join(dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
    return run(process.execPath, [npmCli, '--version']).trim();
  });
  inspect('Git', () => run('git', ['--version']).trim());
  inspect('Codex CLI', () => run(process.env.GRAMPUS_CODEX_COMMAND ?? 'codex', ['--version']).trim());
  inspect('Claude Code CLI', () => run(process.env.GRAMPUS_CLAUDE_COMMAND ?? 'claude', ['--version']).trim());
  if (failures.length)
    throw new Error(
      `Installation refused. Missing or unusable dependencies: ${failures.join(', ')}.\nInstall/fix them and retry. Codex/Claude overrides must name native executables: GRAMPUS_CODEX_COMMAND, GRAMPUS_CLAUDE_COMMAND.`,
    );
  return { checks, npmCli };
}

function canonical(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) && dirname(absolute) === absolute)
    throw new Error(`Installation drive does not exist: ${absolute}`);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(canonical(dirname(absolute)), relative(dirname(absolute), absolute));
}
function inside(parent, child) {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}
export function validateDestination(destination, source) {
  const root = canonical(destination),
    checkout = canonical(source);
  if (/[;\r\n%!"]/.test(root))
    throw new Error('Choose an installation path without semicolons, quotes, %, ! or newlines.');
  if (inside(root, checkout) || inside(checkout, root))
    throw new Error('Install outside the checkout, in a separate directory.');
  if (existsSync(root) && readdirSync(root).length) {
    const owner = join(root, 'grampus-install.json');
    if (!existsSync(owner) || readJson(owner).application !== 'grampus' || readJson(owner).schema !== 1)
      throw new Error('The destination contains files and is not a Grampus installation.');
  }
  return root;
}

/** Generated or installed folders of the dashboard client; the snapshot installs and builds its own. */
const webSkipped = new Set(['node_modules', 'dist']);

function sourceFiles(source) {
  const files = [];
  const walk = (path, skipped = new Set()) => {
    const entry = join(source, path),
      stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`Installation source cannot contain links: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(entry).sort()) if (!skipped.has(name)) walk(join(path, name));
    } else if (stat.isFile()) files.push(path);
    else throw new Error(`Unsupported installation input: ${path}`);
  };
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'scripts/installed-launch.mjs'])
    walk(path);
  // The dashboard client's sources; its node_modules and dist are never copied.
  if (existsSync(join(source, 'web'))) walk('web', webSkipped);
  if (existsSync(join(source, 'scripts/install.mjs'))) walk('scripts/install.mjs');
  for (const path of ['README.md', 'docs', 'examples']) if (existsSync(join(source, path))) walk(path);
  return files.sort();
}
function sourceDigest(source, files) {
  const hash = createHash('sha256');
  for (const path of files)
    hash
      .update(path.replaceAll('\\', '/'))
      .update('\0')
      .update(
        createHash('sha256')
          .update(readFileSync(join(source, path)))
          .digest(),
      );
  return hash.digest('hex');
}
/** Copy inputs, never hardlink them. Detect source edits during the copy. */
export function copySourceSnapshot(source, stage) {
  const files = sourceFiles(source),
    before = sourceDigest(source, files);
  for (const path of files) {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    copyFileSync(join(source, path), join(stage, path));
  }
  if (before !== sourceDigest(stage, files) || before !== sourceDigest(source, sourceFiles(source)))
    throw new Error('Checkout changed while copying. Retry the installer after edits settle.');
  return before;
}

/** Build at the permanent path: Windows readers can prevent renaming its parent directory. */
export function createVersionDirectory(root, version) {
  const id = `${version.replaceAll(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, 'versions', id),
    token = randomUUID();
  mkdirSync(join(root, 'versions'), { recursive: true });
  mkdirSync(directory);
  writeFileSync(
    join(directory, '.grampus-install-owner.json'),
    JSON.stringify({ application: 'grampus', token }) + '\n',
    { flag: 'wx' },
  );
  return { id, directory, token };
}

/** Only discard this invocation's generated, unselected version. */
export function discardUnselectedVersion(root, directory, token) {
  const versions = canonical(join(root, 'versions')),
    target = canonical(directory);
  if (dirname(target) !== versions || !/^[a-zA-Z0-9-]+$/.test(basename(target)))
    throw new Error('Refusing to remove a path outside the installation versions directory.');
  const owner = readJson(join(target, '.grampus-install-owner.json'));
  if (typeof token !== 'string' || owner.application !== 'grampus' || owner.token !== token)
    throw new Error('Refusing to remove a version owned by another installation attempt.');
  if (existsSync(join(root, 'current.json')) && readJson(join(root, 'current.json')).release === basename(target))
    throw new Error('Refusing to remove the selected version.');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function buildSnapshot(source, root, stage, npmCli) {
  const digest = copySourceSnapshot(source, stage),
    pkg = readJson(join(stage, 'package.json'));
  const config = readJson(join(stage, 'tsconfig.json'));
  config.include = ['src/**/*.ts'];
  writeFileSync(join(stage, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
  let commit = null,
    dirty = true;
  try {
    commit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).trim();
    dirty = Boolean(run('git', ['status', '--porcelain'], { cwd: source }).trim());
  } catch {
    /* A source archive can still be installed. */
  }
  const id = basename(stage);
  const build = {
    id,
    version: pkg.version,
    commit,
    dirty,
    sourceDigest: digest,
    builtAt: new Date().toISOString(),
    source,
    installRoot: root,
  };
  console.log('Installing locked build dependencies into the snapshot…');
  const npm = (args, cwd = stage) =>
    run(process.execPath, [npmCli, ...args, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd,
      stdio: 'inherit',
      timeout: 300000,
      env: { ...process.env, NODE_ENV: 'development' },
    });
  npm(['ci', '--include=dev', '--include=optional']);
  console.log('Building the independent snapshot…');
  run(
    process.execPath,
    [join(stage, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(stage, 'tsconfig.json')],
    { cwd: stage, stdio: 'inherit', timeout: 120000 },
  );
  npm(['prune', '--omit=dev', '--include=optional']);
  buildDashboardClient(stage, npm);
  writeFileSync(join(stage, 'grampus-build.json'), JSON.stringify(build, null, 2) + '\n');
  // Importing the CLI verifies its runtime imports; doctor additionally probes installed external CLIs on request.
  const info = JSON.parse(
    run(process.execPath, [join(stage, 'dist', 'src', 'cli.js'), 'version', '--json'], { cwd: stage }),
  );
  if (info.channel !== 'installed' || info.version !== pkg.version || info.build?.id !== id)
    throw new Error('Installed version smoke check failed.');
  for (const file of [
    'web/dist/index.html',
    'web/dist/favicon.svg',
    'src/process/native/check.ps1',
    'src/process/native/check.cs',
    'src/process/native/process.ps1',
    'dist/src/server/ui-worker.js',
    'dist/src/process/check-host.js',
    'dist/src/execution/delivery-worker.js',
    'dist/src/execution/implementation-worker.js',
    `node_modules/@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`,
  ]) {
    if (!existsSync(join(stage, file))) throw new Error(`Snapshot is missing a required runtime asset: ${file}`);
  }
  if (!readdirSync(join(stage, 'web', 'dist', 'assets')).some(name => name.endsWith('.js')))
    throw new Error('Snapshot is missing a required runtime asset: web/dist/assets/*.js');
  return build;
}

function viteBuild(web) {
  run(process.execPath, [join(web, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: web,
    stdio: 'inherit',
    timeout: 300000,
  });
}

/**
 * Builds the dashboard client inside the snapshot from its copied sources and lockfile, so the installed
 * page always matches the installed server. Only `web/dist` is kept; the client's build dependencies are
 * removed afterwards. Type checking is a development step (`npm --prefix web run typecheck`), not repeated here.
 * `npm(args, cwd)` runs npm; `vite(web)` runs the Vite build (tests pass their own).
 */
export function buildDashboardClient(stage, npm, vite = viteBuild) {
  const web = join(stage, 'web');
  if (!existsSync(join(web, 'package-lock.json')))
    throw new Error('The checkout has no web/ dashboard client to build; reinstall from a complete checkout.');
  console.log('Installing and building the dashboard client…');
  npm(['ci', '--include=dev', '--include=optional'], web);
  vite(web);
  rmSync(join(web, 'node_modules'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function registerUserPath(bin) {
  // Keep the original unexpanded PATH entries, avoiding setx truncation and expansion.
  run(
    powershell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
$grampusBin = $env:GRAMPUS_INSTALL_BIN
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$hasBin = @($userPath -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim().TrimEnd('\\') -ieq $grampusBin.TrimEnd('\\') }).Count -gt 0
if (-not $hasBin) {
  $updated = if ([string]::IsNullOrEmpty($userPath)) { $grampusBin } else { $userPath.TrimEnd(';') + ';' + $grampusBin }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
}
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class GrampusEnvironment { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
  $messageResult = [UIntPtr]::Zero
  [void][GrampusEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$messageResult)
} catch { }
`,
    ],
    { env: { ...process.env, GRAMPUS_INSTALL_BIN: bin } },
  );
}

/** Publish a fully checked version. Existing processes keep their original immutable version. */
export function activateSnapshot(root, stage, build) {
  const versions = canonical(join(root, 'versions'));
  if (
    dirname(canonical(stage)) !== versions ||
    basename(stage) !== build.id ||
    !/^[a-zA-Z0-9-]+$/.test(build.id) ||
    readJson(join(stage, 'grampus-build.json')).id !== build.id
  )
    throw new Error('Invalid installation version directory or build id.');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, content] of [
    ['grampus.cmd', shim],
    ['launch.mjs', readFileSync(join(stage, 'scripts', 'installed-launch.mjs'), 'utf8')],
  ]) {
    const file = join(bin, name);
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') !== content)
        throw new Error(
          `Existing launcher differs: ${file}. Keep the existing installation and choose another directory.`,
        );
    } else writeFileSync(file, content, { flag: 'wx' });
  }
  // Keep this path unchanged after npm and the smoke process have used it.
  // A scanner/reader may still hold a file without FILE_SHARE_DELETE on Windows.
  const pointer = join(root, `.current-${randomUUID()}.json`);
  writeFileSync(pointer, JSON.stringify({ schema: 1, release: build.id }) + '\n', { flag: 'wx' });
  renameSync(pointer, join(root, 'current.json'));
  return stage;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      yes: { type: 'boolean' },
      'no-path': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Grampus installer: node scripts/install.mjs [--dir <directory>] [--yes] [--no-path]\nUpdates use the current checkout without fetching. --no-path skips user PATH registration.',
    );
    return;
  }
  console.log('Grampus · Windows per-user installer\nChecking dependencies…');
  const dependencies = checkDependencies();
  for (const check of dependencies.checks) console.log(`  OK ${check.name}: ${check.detail}`);
  const preferred =
    values.dir ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Grampus');
  let selected = preferred;
  const prompt =
    !values.yes && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  if (!values.yes && !prompt)
    throw new Error('An interactive terminal is required; use --yes to accept the displayed defaults.');
  try {
    if (!values.dir && prompt)
      selected = (await prompt.question(`\nInstall directory [${preferred}]: `)).trim() || preferred;
    const root = validateDestination(selected, sourceRoot),
      ownerFile = join(root, 'grampus-install.json');
    const owner = existsSync(ownerFile) ? readJson(ownerFile) : null;
    const addToPath = !values['no-path'] && (owner?.addToPath ?? true);
    const previous = existsSync(join(root, 'current.json')) ? readJson(join(root, 'current.json')).release : null;
    console.log(
      `\n${previous ? 'Update' : 'Install'} Grampus ${readJson(join(sourceRoot, 'package.json')).version}\nSource: ${sourceRoot}\nDestination: ${root}\nCurrent build: ${previous ?? 'none'}\nAdd command to user PATH: ${addToPath ? 'yes' : 'no'}\nInstalled dashboard: port 4317; development: port 4318\nTask data is separate from development. Existing task data is preserved.\nThis copies the current checkout, including local changes; it does not fetch or pull.`,
    );
    if (prompt && !/^y(es)?$/i.test((await prompt.question('\nContinue? [y/N]: ')).trim())) {
      console.log('Cancelled.');
      return;
    }
    mkdirSync(root, { recursive: true });
    const lockPath = join(root, 'install.lock');
    let lock;
    try {
      lock = openSync(lockPath, 'wx');
    } catch {
      throw new Error(
        `Another installation may be running. Inspect ${lockPath}; remove it only after that installer has exited.`,
      );
    }
    let candidate;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      if (!owner)
        writeFileSync(ownerFile, JSON.stringify({ schema: 1, application: 'grampus', addToPath }) + '\n', {
          flag: 'wx',
        });
      candidate = createVersionDirectory(root, readJson(join(sourceRoot, 'package.json')).version);
      const build = buildSnapshot(sourceRoot, root, candidate.directory, dependencies.npmCli);
      if (addToPath) registerUserPath(join(root, 'bin'));
      activateSnapshot(root, candidate.directory, build);
      candidate = undefined;
      console.log(
        `\nInstalled Grampus ${build.version} · build ${build.id}\nOpen a new terminal, then run grampus.\nVersion: grampus version\nUpdate from this checkout: grampus update\nPrevious version folders are retained; updates do not change already-running processes.`,
      );
      if (!addToPath) console.log(`Command location: ${join(root, 'bin', 'grampus.cmd')}`);
    } finally {
      try {
        if (candidate && existsSync(candidate.directory)) {
          try {
            discardUnselectedVersion(root, candidate.directory, candidate.token);
          } catch {
            console.error(
              `Unselected build retained at ${candidate.directory}; the current selection was not changed by cleanup.`,
            );
          }
        }
      } finally {
        closeSync(lock);
        unlinkSync(lockPath);
      }
    }
  } finally {
    prompt?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
