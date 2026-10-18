import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shim = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode "%~dp0launch.mjs" %*\r\nexit /b %errorlevel%\r\n';
const powershell = () => resolve(process.env.SystemRoot ?? process.env.WINDIR ?? '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function requireNode(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+/.test(version) || Number(version.split('.')[0]) < 24) throw new Error(`Node.js 24 or later is required (found ${version}).`);
}

/** Check external prerequisites before creating any installation files. No inference or login prompts. */
export function checkDependencies() {
  if (process.platform !== 'win32') throw new Error('This installer currently supports Windows only.');
  requireNode();
  const checks = [], failures = [];
  const inspect = (name, action) => {
    try { const detail = action(); checks.push({ name, detail }); }
    catch { failures.push(name); }
  };
  inspect('Node.js with node:sqlite', () => run(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close();console.log(process.version)"]).trim());
  inspect('Windows PowerShell 5.1+', () => run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', "if ($PSVersionTable.PSVersion -lt [Version]'5.1') { exit 1 }; $PSVersionTable.PSVersion.ToString()" ]).trim());
  let npmCli;
  inspect('npm', () => {
    npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli)) {
      const command = run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source"]).trim();
      npmCli = join(dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
    return run(process.execPath, [npmCli, '--version']).trim();
  });
  inspect('Git', () => run('git', ['--version']).trim());
  inspect('Codex CLI', () => run(process.env.GRAMPUS_CODEX_COMMAND ?? 'codex', ['--version']).trim());
  inspect('Claude Code CLI', () => run(process.env.GRAMPUS_CLAUDE_COMMAND ?? 'claude', ['--version']).trim());
  if (failures.length) throw new Error(`Installation refused. Missing or unusable dependencies: ${failures.join(', ')}.\nInstall/fix them and retry. Codex/Claude overrides must name native executables: GRAMPUS_CODEX_COMMAND, GRAMPUS_CLAUDE_COMMAND.`);
  return { checks, npmCli };
}

function canonical(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) && dirname(absolute) === absolute) throw new Error(`Installation drive does not exist: ${absolute}`);
  return existsSync(absolute) ? realpathSync(absolute) : join(canonical(dirname(absolute)), relative(dirname(absolute), absolute));
}
function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
export function validateDestination(destination, source) {
  const root = canonical(destination), checkout = canonical(source);
  if (/[;\r\n%!"]/.test(root)) throw new Error('Choose an installation path without semicolons, quotes, %, ! or newlines.');
  if (inside(root, checkout) || inside(checkout, root)) throw new Error('Install outside the checkout, in a separate directory.');
  if (existsSync(root) && readdirSync(root).length) {
    const owner = join(root, 'grampus-install.json');
    if (!existsSync(owner) || readJson(owner).application !== 'grampus' || readJson(owner).schema !== 1) throw new Error('The destination contains files and is not a Grampus installation.');
  }
  return root;
}

function sourceFiles(source) {
  const files = [];
  const walk = path => {
    const entry = join(source, path), stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`Installation source cannot contain links: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(entry).sort()) walk(join(path, name));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`Unsupported installation input: ${path}`);
  };
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'scripts/installed-launch.mjs']) walk(path);
  if (existsSync(join(source, 'scripts/install.mjs'))) walk('scripts/install.mjs');
  for (const path of ['README.md', 'docs', 'examples']) if (existsSync(join(source, path))) walk(path);
  return files.sort();
}
function sourceDigest(source, files) {
  const hash = createHash('sha256');
  for (const path of files) hash.update(path.replaceAll('\\', '/')).update('\0').update(createHash('sha256').update(readFileSync(join(source, path))).digest());
  return hash.digest('hex');
}
/** Copy inputs, never hardlink them. Detect source edits during the copy. */
export function copySourceSnapshot(source, stage) {
  const files = sourceFiles(source), before = sourceDigest(source, files);
  for (const path of files) { mkdirSync(dirname(join(stage, path)), { recursive: true }); copyFileSync(join(source, path), join(stage, path)); }
  if (before !== sourceDigest(stage, files) || before !== sourceDigest(source, sourceFiles(source))) throw new Error('Checkout changed while copying. Retry the installer after edits settle.');
  return before;
}

/** Only remove a generated staging directory under this installation's versions directory. */
export function removeStage(root, stage) {
  const versions = canonical(join(root, 'versions')), target = canonical(stage);
  if (dirname(target) !== versions || !relative(versions, target).startsWith('.staging-')) throw new Error('Refusing to remove a path outside the installation staging area.');
  rmSync(target, { recursive: true, force: true });
}

export function buildSnapshot(source, root, stage, npmCli) {
  const digest = copySourceSnapshot(source, stage), pkg = readJson(join(stage, 'package.json'));
  const config = readJson(join(stage, 'tsconfig.json')); config.include = ['src/**/*.ts'];
  writeFileSync(join(stage, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
  let commit = null, dirty = true;
  try { commit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).trim(); dirty = Boolean(run('git', ['status', '--porcelain'], { cwd: source }).trim()); } catch { /* A source archive can still be installed. */ }
  const id = `${pkg.version.replaceAll(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const build = { id, version: pkg.version, commit, dirty, sourceDigest: digest, builtAt: new Date().toISOString(), source, installRoot: root };
  console.log('Installing locked build dependencies into the snapshot…');
  const npm = args => run(process.execPath, [npmCli, ...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', timeout: 300000,
    env: { ...process.env, NODE_ENV: 'development' } });
  npm(['ci', '--include=dev', '--include=optional']);
  console.log('Building the independent snapshot…');
  run(process.execPath, [join(stage, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(stage, 'tsconfig.json')], { cwd: stage, stdio: 'inherit', timeout: 120000 });
  npm(['prune', '--omit=dev', '--include=optional']);
  writeFileSync(join(stage, 'grampus-build.json'), JSON.stringify(build, null, 2) + '\n');
  // Importing the CLI verifies its runtime imports; doctor additionally probes installed external CLIs on request.
  const info = JSON.parse(run(process.execPath, [join(stage, 'dist', 'src', 'cli.js'), 'version', '--json'], { cwd: stage }));
  if (info.channel !== 'installed' || info.version !== pkg.version || info.build?.id !== id) throw new Error('Installed version smoke check failed.');
  for (const file of ['src/ui/index.html', 'src/ui/app.js', 'src/ui/app.css', 'src/native/check.ps1', 'src/native/check.cs', 'src/native/process.ps1',
    'dist/src/ui-worker.js', 'dist/src/check-host.js', 'dist/src/delivery-worker.js', 'dist/src/implementation-worker.js',
    `node_modules/@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`]) {
    if (!existsSync(join(stage, file))) throw new Error(`Snapshot is missing a required runtime asset: ${file}`);
  }
  return build;
}

export function registerUserPath(bin) {
  // Keep the original unexpanded PATH entries, avoiding setx truncation and expansion.
  run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', `
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
`], { env: { ...process.env, GRAMPUS_INSTALL_BIN: bin } });
}

/** Publish a fully checked version. Existing processes keep their original immutable version. */
export function activateSnapshot(root, stage, build) {
  const versions = canonical(join(root, 'versions'));
  if (dirname(canonical(stage)) !== versions || !relative(versions, canonical(stage)).startsWith('.staging-') || !/^[a-zA-Z0-9-]+$/.test(build.id)) throw new Error('Invalid installation staging area or build id.');
  const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  for (const [name, content] of [['grampus.cmd', shim], ['launch.mjs', readFileSync(join(stage, 'scripts', 'installed-launch.mjs'), 'utf8')]]) {
    const file = join(bin, name);
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') !== content) throw new Error(`Existing launcher differs: ${file}. Keep the existing installation and choose another directory.`);
    } else writeFileSync(file, content, { flag: 'wx' });
  }
  const destination = join(versions, build.id);
  if (!inside(versions, destination) || existsSync(destination)) throw new Error('Build destination already exists or is invalid.');
  renameSync(stage, destination);
  const pointer = join(root, `.current-${randomUUID()}.json`);
  writeFileSync(pointer, JSON.stringify({ schema: 1, release: build.id }) + '\n', { flag: 'wx' });
  renameSync(pointer, join(root, 'current.json'));
  return destination;
}

async function main() {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, yes: { type: 'boolean' }, 'no-path': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('Grampus installer: node scripts/install.mjs [--dir <directory>] [--yes] [--no-path]\nUpdates use the current checkout without fetching. --no-path skips user PATH registration.'); return; }
  console.log('Grampus · Windows per-user installer\nChecking dependencies…');
  const dependencies = checkDependencies();
  for (const check of dependencies.checks) console.log(`  OK ${check.name}: ${check.detail}`);
  const preferred = values.dir ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Grampus');
  let selected = preferred;
  const prompt = !values.yes && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  if (!values.yes && !prompt) throw new Error('An interactive terminal is required; use --yes to accept the displayed defaults.');
  try {
    if (!values.dir && prompt) selected = (await prompt.question(`\nInstall directory [${preferred}]: `)).trim() || preferred;
    const root = validateDestination(selected, sourceRoot), ownerFile = join(root, 'grampus-install.json');
    const owner = existsSync(ownerFile) ? readJson(ownerFile) : null;
    const addToPath = !values['no-path'] && (owner?.addToPath ?? true);
    const previous = existsSync(join(root, 'current.json')) ? readJson(join(root, 'current.json')).release : null;
    console.log(`\n${previous ? 'Update' : 'Install'} Grampus ${readJson(join(sourceRoot, 'package.json')).version}\nSource: ${sourceRoot}\nDestination: ${root}\nCurrent build: ${previous ?? 'none'}\nAdd command to user PATH: ${addToPath ? 'yes' : 'no'}\nInstalled dashboard: port 4317; development: port 4318\nTask data is separate from development. Existing task data is preserved.\nThis copies the current checkout, including local changes; it does not fetch or pull.`);
    if (prompt && !/^y(es)?$/i.test((await prompt.question('\nContinue? [y/N]: ')).trim())) { console.log('Cancelled.'); return; }
    mkdirSync(root, { recursive: true });
    const lockPath = join(root, 'install.lock');
    let lock;
    try { lock = openSync(lockPath, 'wx'); } catch { throw new Error(`Another installation may be running. Inspect ${lockPath}; remove it only after that installer has exited.`); }
    let stage;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      if (!owner) writeFileSync(ownerFile, JSON.stringify({ schema: 1, application: 'grampus', addToPath }) + '\n', { flag: 'wx' });
      mkdirSync(join(root, 'versions'), { recursive: true });
      stage = join(root, 'versions', `.staging-${randomUUID()}`); mkdirSync(stage);
      const build = buildSnapshot(sourceRoot, root, stage, dependencies.npmCli);
      if (addToPath) registerUserPath(join(root, 'bin'));
      activateSnapshot(root, stage, build);
      stage = undefined;
      console.log(`\nInstalled Grampus ${build.version} · build ${build.id}\nOpen a new terminal, then run grampus.\nVersion: grampus version\nUpdate from this checkout: grampus update\nPrevious version folders are retained; updates do not change already-running processes.`);
      if (!addToPath) console.log(`Command location: ${join(root, 'bin', 'grampus.cmd')}`);
    } finally {
      if (stage && existsSync(stage)) removeStage(root, stage);
      closeSync(lock); unlinkSync(lockPath);
    }
  } finally { prompt?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
