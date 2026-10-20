// Verifies installation isolation, activation and prerequisites using temporary installations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installerUrl = new URL('../../scripts/install.mjs', import.meta.url);
const installer = await import(installerUrl.href);
const launcher = fileURLToPath(new URL('../../scripts/installed-launch.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function orcaInputs(directory: string) {
  copyFileSync(
    fileURLToPath(new URL('../../scripts/build-orca-plugin.mjs', import.meta.url)),
    join(directory, 'scripts', 'build-orca-plugin.mjs'),
  );
  cpSync(fileURLToPath(new URL('../../plugins/orca', import.meta.url)), join(directory, 'plugins', 'orca'), {
    recursive: true,
  });
}

function orcaPackage(stage: string, root: string) {
  const folder = join(stage, 'orca-plugin');
  mkdirSync(folder);
  copyFileSync(join(stage, 'plugins', 'orca', 'orca-plugin.json'), join(folder, 'orca-plugin.json'));
  copyFileSync(join(stage, 'plugins', 'orca', 'installed.mjs'), join(folder, 'main.mjs'));
  writeFileSync(
    join(folder, 'launch.json'),
    JSON.stringify({ schema: 1, installation: root, launcher: join(root, 'bin', 'launch.mjs') }),
  );
}

test('installed launcher stays byte-identical so existing installations can update', () => {
  // activateSnapshot refuses to replace a differing bin/launch.mjs, so any edit (even formatting)
  // blocks every update of an existing installation. Change it only with an installer migration.
  const content = readFileSync(launcher, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    '2e8e6538b613ecc65b6235ae7df15c1c36dbfdc3c33595273232a5c56d35473f',
  );
});

test('installer rejects unsupported Node versions and unsafe destinations', t => {
  for (const version of ['18.20.0', '22.15.0', '23.9.0', 'invalid'])
    assert.throws(() => installer.requireNode(version), /24 or later/);
  for (const version of ['24.0.0', '24.22.0', '25.8.1']) installer.requireNode(version);
  const root = mkdtempSync(join(tmpdir(), 'grampus-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'checkout');
  mkdirSync(source);
  assert.throws(() => installer.validateDestination(source, source), /outside the checkout/);
  assert.throws(() => installer.validateDestination(join(source, 'installed'), source), /outside the checkout/);
  assert.throws(() => installer.validateDestination(root, source), /outside the checkout/);
  const unrelated = join(root, 'unrelated');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => installer.validateDestination(unrelated, source), /not a Grampus installation/);
  assert.throws(() => installer.validateDestination(join(root, 'bad;path'), source), /semicolons/);
  assert.equal(
    installer.validateDestination(join(root, 'installed with spaces'), source),
    join(root, 'installed with spaces'),
  );
  assert.throws(() => installer.discardUnselectedVersion(root, source, 'not-owned'), /Refusing to remove/);
  assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('installed snapshots launch independently, preserve data and switch versions only on activation', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus install spaces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'checkout'),
    installRoot = join(root, 'installed'),
    data = join(root, 'local data');
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(source, 'scripts'));
  orcaInputs(source);
  mkdirSync(join(installRoot, 'versions'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'grampus', version: '0.1.0', type: 'module' }));
  writeFileSync(join(source, 'package-lock.json'), '{}');
  writeFileSync(join(source, 'tsconfig.json'), '{}');
  writeFileSync(join(source, 'src', 'fixture.ts'), 'original source');
  copyFileSync(launcher, join(source, 'scripts', 'installed-launch.mjs'));
  const prepare = (message: string) => {
    const candidate = installer.createVersionDirectory(installRoot, '0.1.0'),
      stage = candidate.directory;
    const digest = installer.copySourceSnapshot(source, stage);
    mkdirSync(join(stage, 'dist', 'src', 'config'), { recursive: true });
    mkdirSync(join(stage, 'dist', 'src', 'persistence'), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL('../src/config/runtime.js', import.meta.url)),
      join(stage, 'dist', 'src', 'config', 'runtime.js'),
    );
    copyFileSync(
      fileURLToPath(new URL('../src/persistence/store.js', import.meta.url)),
      join(stage, 'dist', 'src', 'persistence', 'store.js'),
    );
    writeFileSync(
      join(stage, 'dist', 'src', 'cli.js'),
      `import {versionInformation} from './config/runtime.js'; console.log(JSON.stringify({...versionInformation(), message: ${JSON.stringify(message)}, cwd: process.cwd(), args: process.argv.slice(2)}));`,
    );
    const build = {
      id: candidate.id,
      version: '0.1.0',
      commit: null,
      dirty: true,
      sourceDigest: digest,
      builtAt: new Date().toISOString(),
      source,
      installRoot,
    };
    writeFileSync(join(stage, 'grampus-build.json'), JSON.stringify(build));
    orcaPackage(stage, installRoot);
    return { stage, build, token: candidate.token };
  };
  const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: data };
  delete environment.GRAMPUS_HOME;
  const run = (path: string, ...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [path, ...args], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  const first = prepare('first version');
  installer.activateSnapshot(installRoot, first.stage, first.build);
  const launch = join(installRoot, 'bin', 'launch.mjs'),
    firstInfo = run(launch, 'version', 'an argument with spaces');
  assert.equal(firstInfo.message, 'first version');
  assert.equal(firstInfo.channel, 'installed');
  assert.equal(firstInfo.dashboardPort, 4317);
  assert.deepEqual(firstInfo.args, ['version', 'an argument with spaces']);
  assert.equal(firstInfo.cwd, root);
  assert.equal(firstInfo.dataDirectory, join(data, 'Grampus', 'installed'));
  mkdirSync(firstInfo.dataDirectory, { recursive: true });
  const sentinel = join(firstInfo.dataDirectory, 'retained.txt');
  writeFileSync(sentinel, 'installed task data');
  writeFileSync(join(source, 'src', 'fixture.ts'), 'new source, not automatically installed');
  assert.equal(readFileSync(join(first.stage, 'src', 'fixture.ts'), 'utf8'), 'original source');
  assert.equal(run(launch).message, 'first version');
  const second = prepare('second version');
  assert.equal(run(launch).message, 'first version');
  installer.activateSnapshot(installRoot, second.stage, second.build);
  assert.equal(run(launch).message, 'second version');
  assert.equal(run(join(first.stage, 'dist', 'src', 'cli.js')).message, 'first version');
  assert.throws(() => installer.discardUnselectedVersion(installRoot, second.stage, second.token), /selected version/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'installed task data');
  const failed = prepare('must not be selected');
  writeFileSync(join(failed.stage, 'scripts', 'installed-launch.mjs'), 'invalid launcher');
  assert.throws(() => installer.activateSnapshot(installRoot, failed.stage, failed.build), /launcher differs/);
  assert.equal(run(launch).message, 'second version');
  assert.throws(
    () => installer.discardUnselectedVersion(installRoot, failed.stage, 'wrong-token'),
    /another installation attempt/,
  );
  installer.discardUnselectedVersion(installRoot, failed.stage, failed.token);
  assert.equal(existsSync(failed.stage), false);
  // Even moving the entire development checkout away cannot break installed launches.
  rmSync(source, { recursive: true });
  assert.equal(run(launch).message, 'second version');
});

test('snapshots copy the dashboard client sources but never its node_modules or build output', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-install-web-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'checkout'),
    stage = join(root, 'stage');
  for (const folder of ['src', 'scripts', 'web/src', 'web/public', 'web/node_modules/vite', 'web/dist/assets'])
    mkdirSync(join(source, folder), { recursive: true });
  for (const file of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'src/cli.ts',
    'scripts/installed-launch.mjs',
  ])
    writeFileSync(join(source, file), '{}');
  orcaInputs(source);
  for (const file of [
    'web/package.json',
    'web/package-lock.json',
    'web/index.html',
    'web/src/main.ts',
    'web/public/favicon.svg',
  ])
    writeFileSync(join(source, file), 'client source');
  writeFileSync(join(source, 'web/node_modules/vite/index.js'), 'installed dependency');
  writeFileSync(join(source, 'web/dist/assets/index-old.js'), 'stale build output');
  installer.copySourceSnapshot(source, stage);
  assert.equal(readFileSync(join(stage, 'web/src/main.ts'), 'utf8'), 'client source');
  assert.equal(existsSync(join(stage, 'web/public/favicon.svg')), true);
  assert.equal(existsSync(join(stage, 'web/node_modules')), false);
  assert.equal(existsSync(join(stage, 'web/dist')), false, 'the snapshot builds its own client');
  assert.equal(existsSync(join(stage, 'plugins/orca/installed.mjs')), true);
  assert.equal(existsSync(join(stage, 'scripts/build-orca-plugin.mjs')), true);
  // The build installs the client's locked dependencies, runs Vite and keeps only web/dist.
  const calls: { args: string[]; cwd: string }[] = [];
  mkdirSync(join(stage, 'web', 'node_modules'), { recursive: true });
  installer.buildDashboardClient(
    stage,
    (args: string[], cwd: string) => calls.push({ args, cwd }),
    () => {},
  );
  assert.deepEqual(calls, [{ args: ['ci', '--include=dev', '--include=optional'], cwd: join(stage, 'web') }]);
  assert.equal(existsSync(join(stage, 'web', 'node_modules')), false);
  rmSync(join(stage, 'web', 'package-lock.json'));
  assert.throws(
    () =>
      installer.buildDashboardClient(
        stage,
        () => {},
        () => {},
      ),
    /no web\/ dashboard client/,
  );
});

test('version commands expose development identity and isolate default data without creating a journal', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: root };
  delete environment.GRAMPUS_HOME;
  const run = (args: string[], env = environment) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const info = JSON.parse(run(['version', '--json']));
  assert.equal(info.channel, 'development');
  assert.equal(info.dashboardPort, 4318);
  assert.equal(info.build, null);
  assert.match(info.dataDirectory, /development/);
  assert.equal(existsSync(info.dataDirectory), false);
  assert.match(run(['--version']), /Grampus 0\.5\.0 \(development\)/);
  assert.equal(run(['-v']), run(['--version']));
  assert.match(run(['--help']), /update.*checkout/);
  const overridden = JSON.parse(run(['version', '--json'], { ...environment, GRAMPUS_HOME: join(root, 'explicit') }));
  assert.equal(overridden.dataDirectory, join(root, 'explicit'));
});

test(
  'activation succeeds while a Windows reader holds a file in the new version',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-locked-activation-'));
    const candidate = installer.createVersionDirectory(root, '0.1.0'),
      version = candidate.directory;
    mkdirSync(join(version, 'scripts'), { recursive: true });
    orcaInputs(version);
    mkdirSync(join(version, 'dist', 'src'), { recursive: true });
    copyFileSync(launcher, join(version, 'scripts', 'installed-launch.mjs'));
    writeFileSync(join(version, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(version, 'dist', 'src', 'cli.js'), `console.log(${JSON.stringify(candidate.id)});\n`);
    writeFileSync(join(version, 'grampus-build.json'), JSON.stringify({ id: candidate.id }));
    orcaPackage(version, root);
    writeFileSync(join(root, 'current.json'), JSON.stringify({ schema: 1, release: 'previous-version' }));
    const payload = join(version, 'payload.txt');
    writeFileSync(payload, 'Held open by a reader while activating');
    const script = join(root, 'hold.ps1');
    writeFileSync(
      script,
      "$ErrorActionPreference='Stop'; $held=[IO.File]::Open($args[0], [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('ready'); [void][Console]::ReadLine(); $held.Dispose()\n",
    );
    const child = spawn(
      join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, payload],
      { cwd: root, windowsHide: true, stdio: 'pipe' },
    );
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>(done => child.once('close', () => done()));
    t.after(async () => {
      child.stdin.end();
      await closed;
      rmSync(root, { recursive: true, force: true });
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Reader did not become ready: ${stderr}`));
      }, 15000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        done();
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`Reader exited early: ${stderr}`));
      });
    });
    installer.activateSnapshot(root, version, { id: candidate.id });
    assert.equal(child.exitCode, null, 'Activation must succeed while the reader is still holding the file');
    assert.equal(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).release, candidate.id);
    assert.equal(
      execFileSync(process.execPath, [join(root, 'bin', 'launch.mjs')], { cwd: root, encoding: 'utf8' }).trim(),
      candidate.id,
    );
  },
);

test('bare CLI opens the dashboard from an unrelated directory and retains explicit database selection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-bare-cli-')),
    db = join(root, 'explicit.sqlite');
  const child = spawn(process.execPath, [cli, '--no-open', '--port', '0', '--db', db], {
    cwd: root,
    env: { ...process.env, GRAMPUS_HOME: join(root, 'data') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(done => child.once('close', () => done()));
  t.after(async () => {
    child.kill();
    await closed;
    rmSync(root, { recursive: true, force: true });
  });
  const url = await new Promise<string>((done, reject) => {
    let output = '',
      errors = '';
    const timer = setTimeout(() => reject(new Error(`Dashboard did not start: ${output} ${errors}`)), 15000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /Grampus dashboard: (http:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        done(match[1]!);
      }
    });
    child.stderr.on('data', chunk => {
      errors += chunk.toString();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`Dashboard exited: ${errors}`));
    });
  });
  const address = new URL(url);
  // The page itself is covered by test/ui-static.test.ts; a checkout without a web build explains itself.
  assert.ok([200, 503].includes((await fetch(address.origin)).status));
  const response = await fetch(address.origin + '/api/v1/overview', {
    headers: { Authorization: `Bearer ${address.hash.slice(1)}` },
  });
  const overview = await response.json();
  assert.equal(overview.application.journal, db);
  assert.equal(overview.application.channel, 'development');
  assert.equal(overview.application.version, '0.5.0');
});

test(
  'missing prerequisite refuses installation before any files or PATH changes',
  { skip: process.platform !== 'win32' },
  t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-install-preflight-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const destination = join(root, 'installed');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(installerUrl), '--yes', '--no-path', '--dir', destination],
      {
        env: {
          ...process.env,
          GRAMPUS_CODEX_COMMAND: join(root, 'missing-codex.exe'),
          GRAMPUS_CLAUDE_COMMAND: process.execPath,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Installation refused.*Codex CLI/);
    assert.equal(existsSync(destination), false);
  },
);

test(
  'installer needs no Codex of its own because the pinned package is installed into the snapshot',
  { skip: process.platform !== 'win32' },
  t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-install-pinned-codex-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // PATH holds Git only: no codex, shim or override anywhere.
    const git = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0] ?? '';
    // A held lock stops the installer right after the dependency checks, before any build.
    const destination = join(root, 'installed');
    mkdirSync(destination);
    writeFileSync(
      join(destination, 'grampus-install.json'),
      JSON.stringify({ application: 'grampus', schema: 1, addToPath: false }),
    );
    writeFileSync(join(destination, 'install.lock'), JSON.stringify({ pid: process.pid }));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !['PATH', 'GRAMPUS_CODEX_COMMAND'].includes(name.toUpperCase())),
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(installerUrl), '--yes', '--no-path', '--dir', destination],
      {
        env: {
          ...env,
          PATH: join(git, '..'),
          npm_execpath: join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          GRAMPUS_CLAUDE_COMMAND: process.execPath,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      },
    );
    assert.doesNotMatch(result.stderr, /Installation refused/);
    assert.doesNotMatch(result.stdout, /Codex CLI/);
    assert.match(result.stderr, /Another installation may be running/);
  },
);

test(
  'interactive installer shows its plan and cancellation leaves the destination absent',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-install-prompt-')),
      destination = join(root, 'installed');
    const preload = join(root, 'interactive.mjs');
    // Simulate terminal input without requiring a visible console in the offline suite.
    writeFileSync(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n");
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(preload).href, fileURLToPath(installerUrl), '--no-path', '--dir', destination],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, GRAMPUS_CODEX_COMMAND: process.execPath, GRAMPUS_CLAUDE_COMMAND: process.execPath },
      },
    );
    let output = '',
      errors = '',
      answered = false;
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (!answered && output.includes('Continue?')) {
        answered = true;
        child.stdin.end('n\n');
      }
    });
    child.stderr.on('data', chunk => {
      errors += chunk.toString();
    });
    const closed = new Promise<number | null>((done, reject) => {
      child.once('close', done);
      child.once('error', reject);
    });
    const timer = setTimeout(() => child.kill(), 30000);
    t.after(async () => {
      clearTimeout(timer);
      child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    });
    assert.equal(await closed, 0, errors);
    assert.match(output, /Task data is separate/);
    // Enter accepts by default, so cancelling needs an explicit answer.
    assert.match(output, /Continue\? \[Y\/n\]/);
    assert.match(output, /Cancelled/);
    assert.equal(answered, true);
    assert.equal(existsSync(destination), false);
  },
);

test(
  'installer refuses concurrent updates instead of changing the active version',
  { skip: process.platform !== 'win32' },
  t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-install-lock-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const destination = join(root, 'installed');
    mkdirSync(destination);
    writeFileSync(
      join(destination, 'grampus-install.json'),
      JSON.stringify({ application: 'grampus', schema: 1, addToPath: false }),
    );
    writeFileSync(join(destination, 'current.json'), JSON.stringify({ schema: 1, release: 'keep-current' }));
    writeFileSync(join(destination, 'install.lock'), JSON.stringify({ pid: process.pid }));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(installerUrl), '--yes', '--no-path', '--dir', destination],
      {
        env: { ...process.env, GRAMPUS_CODEX_COMMAND: process.execPath, GRAMPUS_CLAUDE_COMMAND: process.execPath },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another installation may be running/);
    assert.equal(JSON.parse(readFileSync(join(destination, 'current.json'), 'utf8')).release, 'keep-current');
  },
);
