import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { expectedStdout, fixtureFiles, oracle, obsoleteFile, obsoleteContent, deletionOracle, deletionStdout } from '../src/multifile-fixture.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Workspaces } from '../src/workspaces.js';
import { Executions } from '../src/executions.js';
import { Checks } from '../src/checks.js';
import { interruptAfterEdit } from '../src/probe-interruption.js';

const library = `exports.summarize = function(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('invalid');
  return { count: values.length, total: values.reduce((sum, value) => sum + value, 0),
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
};\n`;
const command = `const { summarize } = require('./summary.cjs');
try {
  if (process.argv.length !== 3) throw new Error('arguments');
  console.log(JSON.stringify(summarize(JSON.parse(process.argv[2]))));
} catch { process.stderr.write('invalid input\\n'); process.exitCode = 2; }
`;

test('multi-file oracle rejects the baseline and accepts the complete library/command behavior', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-multifile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(fixtureFiles)) writeFileSync(join(root, file), content);
  const run = () => spawnSync(process.execPath, ['-e', oracle], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(run().status, 0, 'Incomplete baseline must fail');
  writeFileSync(join(root, 'summary.cjs'), library);
  assert.notEqual(run().status, 0, 'Library alone must not satisfy the command criteria');
  writeFileSync(join(root, 'cli.cjs'), command);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expectedStdout);
  assert.equal(result.stderr, '');
});

test('multi-file oracle detects input mutation, coercion, argument and error-output regressions', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-multifile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mutations = [
    [library.replace('return {', 'values.sort(); return {'), command],
    [library.replace("typeof value !== 'number' || !Number.isFinite(value)", '!Number.isFinite(Number(value))'), command],
    [library, command.replace("if (process.argv.length !== 3) throw new Error('arguments');", '')],
    [library, command.replace("process.stderr.write('invalid input\\n')", "process.stdout.write('invalid input\\n')")],
    [library, command.replace('process.exitCode = 2', 'process.exitCode = 1')],
  ];
  for (const [source, cli] of mutations) {
    writeFileSync(join(root, 'summary.cjs'), source!); writeFileSync(join(root, 'cli.cjs'), cli!);
    const result = spawnSync(process.execPath, ['-e', oracle], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'A semantic regression must fail the independent oracle');
  }
});

test('deletion acceptance requires removal, rejects an empty replacement and preserves behavioral checks', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-deletion-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'summary.cjs'), library); writeFileSync(join(root, 'cli.cjs'), command);
  const path = join(root, obsoleteFile);
  const run = () => spawnSync(process.execPath, ['-e', deletionOracle], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  for (const content of [obsoleteContent, '']) {
    writeFileSync(path, content); assert.notEqual(run().status, 0, 'Retained or emptied obsolete files must fail');
  }
  rmSync(path); mkdirSync(path); assert.notEqual(run().status, 0, 'Directory replacements must fail'); rmdirSync(path);
  const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, deletionStdout);
  writeFileSync(join(root, 'cli.cjs'), fixtureFiles['cli.cjs']!);
  assert.notEqual(run().status, 0, 'File removal alone must not satisfy the library/CLI criteria');
});

test('multi-file pilot requires explicit live opt-in and complete continuation arguments', () => {
  const cli = fileURLToPath(new URL('../src/multifile-probe.js', import.meta.url));
  for (const args of [[], ['--provider', 'codex'], ['--live', '--finish', 'missing'], ['--live', '--finish', ''], ['--live', '--provider', 'unknown'], ['--live', '--assessment', 'unused'],
    ['--live', '--finish', 'id', '--db', 'missing', '--assessment', 'missing', '--orca'],
    ['--live', '--finish', 'id', '--db', 'missing', '--assessment', 'missing', '--interrupt-after-edit'],
    ['--live', '--finish', 'id', '--db', 'missing', '--assessment', 'missing', '--create-library'],
    ['--live', '--finish', 'id', '--db', 'missing', '--assessment', 'missing', '--delete-obsolete']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: probe:multifile/);
  }
});

for (const mode of ['existing', 'new', 'delete'] as const) test(`interruption pilot recovers a partial ${mode} file change through a new CLI without replay`, { skip: process.platform !== 'win32' }, async t => {
  const createLibrary = mode === 'new', deleteObsolete = mode === 'delete';
  const root = mkdtempSync(join(tmpdir(), 'grampus-pilot-crash-')), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(fixtureFiles)) {
    if (createLibrary && file === 'summary.cjs') continue;
    writeFileSync(join(repo, file), content);
  }
  if (deleteObsolete) writeFileSync(join(repo, obsoleteFile), obsoleteContent);
  git('add', '.'); git('commit', '-m', 'Baseline');
  const store = new Store(join(root, 'journal.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workflow = new Workflow(store), task = workflow.create({ title: 'Crash pilot fixture', outcome: 'Edit both files', criteria: ['Both files'], plan: 'Exercise crash observer with an offline tool' });
  workflow.approve(task.id, 1);
  const workspace = await new Workspaces(store).create(task.id, 1, repo, join(root, 'workspace'));
  const execution = await new Executions(store).create(workspace.id, 1, 'claude');
  const snapshot = await new Checks(store).snapshot(execution.id);
  const policy = { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest,
    files: createLibrary ? ['cli.cjs'] : ['summary.cjs', 'cli.cjs'], ...(createLibrary ? { create: ['summary.cjs'] } : {}),
    ...(deleteObsolete ? { delete: [obsoleteFile] } : {}) };
  const controller = join(root, 'fixture-controller.mjs');
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const tool = deleteObsolete ? `require('node:fs').unlinkSync('${obsoleteFile}'); setTimeout(() => {}, 30000);`
    : `require('node:fs').writeFileSync('summary.cjs', 'exports.summarize = () => null;\\n'); setTimeout(() => {}, 30000);`;
  writeFileSync(controller, `import {Store} from ${url('store')}; import {Implementations} from ${url('implementations')};
    import {runCheckProcess} from ${url('check-process')};
    const store = new Store(${JSON.stringify(store.path)});
    await new Implementations(store).run(${JSON.stringify(execution.id)}, ${JSON.stringify(policy)}, undefined, {},
      options => runCheckProcess({...options, args: ['-e', ${JSON.stringify(tool)}]}));`);
  const result = await interruptAfterEdit(store, execution, workspace, root, policy, controller);
  assert.equal(result.passed, true); assert.equal(result.taskPhase, 'stopped');
  assert.equal(result.inferenceReplayed, false);
  assert.equal(result.observedChange.kind, deleteObsolete ? 'delete' : 'edit');
  assert.equal(readFileSync(join(workspace.path!, 'cli.cjs'), 'utf8'), fixtureFiles['cli.cjs']);
  assert.ok(store.events(task.id).some(event => event.type === 'probe.interruption_verified'));
});
