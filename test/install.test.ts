// The installer against a real temporary checkout of this build: versions, selection, the launcher on
// PATH, the chat skill, pruning and refusals. A temporary home keeps the skill out of the user's agents.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, type InstallOptions } from '../src/install/install.js';
import { installLayout, packageVersion, selectedBuild } from '../src/install/installation.js';

const repoRoot = join(import.meta.dirname, '..', '..');

function temporary(name: string): string {
  return mkdtempSync(join(tmpdir(), `grampus-install-${name}-`));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A committed checkout holding this build's runtime files, as `npm run build` leaves them. */
function checkout(): string {
  const root = temporary('checkout');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(repoRoot, file), join(root, file));
  cpSync(join(repoRoot, 'skills'), join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  for (const folder of ['dist/src', 'dist/web', 'dist/test'])
    cpSync(join(repoRoot, folder), join(root, folder), { recursive: true });
  commit(root, 'Initial');
  return root;
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
}

/** Run a script as the user would, with agent skills going to a temporary home. */
function node(home: string, script: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: join(home, '.codex') },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function options(source: string, root: string, overrides: Partial<InstallOptions> = {}): InstallOptions {
  const home = temporary('home');
  return {
    checkout: source,
    root,
    allowDirty: false,
    keep: 3,
    now: new Date(),
    installDependencies: dir =>
      cpSync(join(repoRoot, 'node_modules', 'zod'), join(dir, 'node_modules', 'zod'), { recursive: true }),
    runCli: (cli, args) => node(home, cli, ...args),
    registerPath: null,
    log: () => undefined,
    ...overrides,
  };
}

function versions(root: string): string[] {
  return readdirSync(installLayout(root).versions).sort();
}

test('installs a clean checkout as a version that the launcher runs and the skill names from PATH', () => {
  const source = checkout();
  const root = join(temporary('root'), 'Grampus');
  const home = temporary('home');
  const result = install(options(source, root, { runCli: (cli, args) => node(home, cli, ...args) }));
  const sha = git(source, 'rev-parse', 'HEAD');
  assert.equal(result.build.build, `${packageVersion(repoRoot)}+${sha.slice(0, 12)}`);
  assert.equal(result.build.dirty, false);
  assert.equal(result.reused, false);
  assert.equal(selectedBuild(root), result.build.build);
  assert.ok(existsSync(installLayout(root).shim));
  assert.ok(
    !existsSync(join(installLayout(root).versions, result.build.build, 'dist', 'test')),
    'tests are not installed',
  );

  const reported = JSON.parse(node(home, installLayout(root).launcher, 'version', '--json')) as {
    build: { build: string };
    installation: string;
  };
  assert.equal(reported.build.build, result.build.build);
  assert.equal(reported.installation, root);

  const skill = readFileSync(join(home, '.claude', 'skills', 'grampus', 'SKILL.md'), 'utf8');
  assert.match(skill, /^grampus new /m, 'the skill runs grampus from PATH');
  assert.doesNotMatch(skill, /node "/);
  assert.ok(existsSync(join(home, '.codex', 'skills', 'grampus', 'SKILL.md')));
});

test('refuses uncommitted changes unless allowed, and marks such a build dirty', () => {
  const source = checkout();
  writeFileSync(join(source, 'notes.txt'), 'work in progress\n');
  const root = join(temporary('root'), 'Grampus');
  assert.throws(() => install(options(source, root)), /uncommitted changes/);
  assert.ok(!existsSync(installLayout(root).current), 'nothing is selected');

  const result = install(options(source, root, { allowDirty: true, now: new Date('2026-10-22T10:15:30.123Z') }));
  assert.match(result.build.build, /\+[0-9a-f]{12}\.dirty\.20261022T101530Z$/);
  assert.equal(result.build.dirty, true);
});

test('a new commit becomes current, the same commit is reselected, and old versions are pruned', () => {
  const source = checkout();
  const root = join(temporary('root'), 'Grampus');
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 10, minute));
  const first = install(options(source, root, { keep: 2, now: at(0) })).build.build;
  commit(source, 'Second');
  const second = install(options(source, root, { keep: 2, now: at(1) })).build.build;
  assert.equal(selectedBuild(root), second);
  assert.deepEqual(versions(root), [first, second].sort());

  commit(source, 'Third');
  const third = install(options(source, root, { keep: 2, now: at(2) }));
  assert.equal(third.previous, second);
  assert.deepEqual(third.removed, [first]);
  assert.deepEqual(versions(root), [second, third.build.build].sort());

  const again = install(options(source, root, { keep: 2, now: at(3) }));
  assert.equal(again.reused, true);
  assert.equal(again.build.build, third.build.build);
});

test('a version that fails its smoke check is removed and the selection is unchanged', () => {
  const source = checkout();
  const root = join(temporary('root'), 'Grampus');
  const first = install(options(source, root)).build.build;
  commit(source, 'Broken');
  const broken = options(source, root, {
    runCli: (cli, args) => (args[0] === 'version' ? 'not json' : node(temporary('home'), cli, ...args)),
  });
  assert.throws(() => install(broken), /did not start correctly/);
  assert.equal(selectedBuild(root), first);
  assert.deepEqual(versions(root), [first]);
  assert.ok(!existsSync(installLayout(root).lock), 'the lock is released');
});

test('an interrupted install is removed by the next one', () => {
  const source = checkout();
  const root = join(temporary('root'), 'Grampus');
  install(options(source, root));
  mkdirSync(join(installLayout(root).versions, '9.9.9+0123456789ab'));
  commit(source, 'Next');
  const result = install(options(source, root));
  assert.ok(result.removed.includes('9.9.9+0123456789ab'));
});

test('refuses a folder it does not own, an older layout, a folder in the checkout and a held lock', () => {
  const source = checkout();
  const foreign = temporary('foreign');
  writeFileSync(join(foreign, 'readme.txt'), 'not Grampus');
  assert.throws(() => install(options(source, foreign)), /not a Grampus installation/);

  const older = temporary('older');
  writeFileSync(join(older, 'grampus-install.json'), JSON.stringify({ schema: 1, application: 'grampus' }));
  assert.throws(() => install(options(source, older)), /another layout/);

  assert.throws(() => install(options(source, join(source, 'install'))), /outside the checkout/);

  const root = join(temporary('root'), 'Grampus');
  install(options(source, root));
  writeFileSync(installLayout(root).lock, '{}');
  assert.throws(() => install(options(source, root)), /Another install may be running/);
});

test('a development checkout reports itself and does not install the skill', () => {
  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  const home = temporary('home');
  const reported = JSON.parse(node(home, cli, 'version', '--json')) as { build: unknown; root: string };
  assert.equal(reported.build, null);
  assert.match(node(home, cli, '--version'), /development checkout/);
  assert.throws(() => node(home, cli, '--home', home, 'skill', 'install'), /npm run install:local/);
  assert.ok(!existsSync(join(home, '.claude', 'skills')));
});
