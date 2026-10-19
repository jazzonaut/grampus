// Exercises the exported installer against real temporary snapshots and an Orca-copied plugin package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../', import.meta.url));
const installer = await import(new URL('../../scripts/install.mjs', import.meta.url).href);
const packager = await import(new URL('../../scripts/build-orca-plugin.mjs', import.meta.url).href);

test('install and update publish one Orca path which follows selection after being copied by Orca', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'grampus-installed-orca-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'installed with spaces');
  const prepare = async (message: string) => {
    const candidate = installer.createVersionDirectory(root, '0.1.0');
    const stage = candidate.directory;
    mkdirSync(join(stage, 'scripts'));
    mkdirSync(join(stage, 'plugins', 'orca'), { recursive: true });
    mkdirSync(join(stage, 'dist', 'src'), { recursive: true });
    copyFileSync(join(source, 'scripts', 'installed-launch.mjs'), join(stage, 'scripts', 'installed-launch.mjs'));
    copyFileSync(join(source, 'plugins', 'orca', 'main.mjs'), join(stage, 'plugins', 'orca', 'main.mjs'));
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(stage, 'dist', 'src', 'cli.js'),
      `console.log(JSON.stringify({ok:true,message:${JSON.stringify(message)},args:process.argv.slice(2)}));`,
    );
    writeFileSync(join(stage, 'grampus-build.json'), JSON.stringify({ id: candidate.id }));
    await packager.buildOrcaPlugin({ destination: join(stage, 'orca-plugin'), installed: root });
    return { stage, build: { id: candidate.id } };
  };
  const first = await prepare('first');
  installer.activateSnapshot(root, first.stage, first.build);
  const plugin = join(root, 'orca-plugin');
  assert.equal(existsSync(join(plugin, 'orca-plugin.json')), true, 'Installation must publish the Orca package');
  assert.equal(JSON.parse(readFileSync(join(plugin, 'orca-plugin.json'), 'utf8')).name, 'Grampus');
  const config = JSON.parse(readFileSync(join(plugin, 'launch.json'), 'utf8'));
  assert.equal(config.launcher, join(root, 'bin', 'launch.mjs'));
  assert.equal(config.installation, root);
  const copied = join(temporary, 'orca installed copy');
  cpSync(plugin, copied, { recursive: true });
  const module = await import(pathToFileURL(join(copied, 'main.mjs')).href);
  const commands = new Map<string, () => Promise<any>>();
  module.default({ commands: { register: (id: string, handler: () => Promise<any>) => commands.set(id, handler) } });
  assert.deepEqual(await commands.get('open')!(), { ok: true, message: 'first', args: ['open', '--orca'] });
  const second = await prepare('second');
  assert.equal((await commands.get('open')!()).message, 'first', 'An unselected snapshot cannot change commands');
  installer.activateSnapshot(root, second.stage, second.build);
  assert.equal((await commands.get('open')!()).message, 'second', 'The existing copied plugin follows updates');
  assert.deepEqual(await commands.get('stop')!(), { ok: true, message: 'second', args: ['close'] });
  if (process.platform === 'win32') {
    const blocked = await prepare('blocked');
    const previousConfig = readFileSync(join(plugin, 'launch.json'), 'utf8');
    const candidateConfig = join(blocked.stage, 'orca-plugin', 'launch.json');
    const changed = JSON.parse(readFileSync(candidateConfig, 'utf8'));
    changed.node = join(temporary, 'different-node.exe');
    writeFileSync(candidateConfig, JSON.stringify(changed));
    const release = await holdSelection(root);
    try {
      assert.throws(() => installer.activateSnapshot(root, blocked.stage, blocked.build));
      assert.equal(readFileSync(join(plugin, 'launch.json'), 'utf8'), previousConfig, 'Restore the published package');
      assert.equal(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).release, second.build.id);
    } finally {
      await release();
    }
    assert.equal((await commands.get('open')!()).message, 'second');
  }
  const failed = await prepare('failed');
  rmSync(join(failed.stage, 'orca-plugin', 'main.mjs'));
  assert.throws(() => installer.activateSnapshot(root, failed.stage, failed.build));
  assert.equal((await commands.get('open')!()).message, 'second');
  assert.equal(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).release, second.build.id);
  writeFileSync(join(root, 'current.json'), JSON.stringify({ schema: 1, release: '../outside' }));
  await assert.rejects(commands.get('open')!(), /Invalid Grampus installation selection/);
});

/** A real Windows reader denies replacement of the selection file while leaving it readable. */
async function holdSelection(root: string) {
  const script = join(root, 'hold-selection.ps1');
  writeFileSync(
    script,
    "$ErrorActionPreference='Stop'; $held=[IO.File]::Open($args[0], [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('ready'); [void][Console]::ReadLine(); $held.Dispose()\n",
  );
  const child = spawn(
    join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, join(root, 'current.json')],
    { windowsHide: true, stdio: 'pipe' },
  );
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let errors = '';
  child.stderr.on('data', chunk => {
    errors += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Selection reader did not become ready: ${errors}`)), 15000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`Selection reader exited: ${errors}`));
      });
    });
  } catch (error) {
    child.stdin.end();
    await closed;
    throw error;
  }
  return async () => {
    child.stdin.end();
    await closed;
  };
}
