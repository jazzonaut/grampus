// Comparisons end to end with fake Orcas and real Git repositories: entries from one base commit, the
// concurrency limit, the shared spec, the cross-check overlay and the pick.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ComparisonStore, foldComparison, type ComparisonState } from '../src/compare/comparison.js';
import { startComparison } from '../src/compare/create.js';
import { incompatibleChecks } from '../src/compare/cross-check.js';
import { renderComparison, summariseComparison } from '../src/compare/status.js';
import { driveComparison } from '../src/compare/driver.js';
import { queueCommand, queueComparisonCommand } from '../src/control.js';
import type { Recipe } from '../src/domain/recipe.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { uncommittedPaths } from '../src/git/git.js';
import { estimateCost } from '../src/measure/cost.js';
import { drive } from '../src/pipeline/driver.js';
import { foldEvents, type TaskState } from '../src/pipeline/state.js';
import { TaskStore } from '../src/store/task-store.js';
import { FakeOrca, type Behaviour } from './helpers/fake-orca.js';
import {
  checkCommand,
  commitAll,
  createRepository,
  outputPath,
  reviewJson,
  roleOf,
  specText,
  useTestSettings,
  write,
} from './helpers/task-fixture.js';

const alt: Recipe = { ...pipelineRecipe, name: 'alt', build: { agent: 'claude' }, review: { agent: 'codex' } };
const extraCheck = 'node test/extra.test.js';

/** The worktree a prompt names, from the `<worktree>/.grampus/` paths in it. */
function worktreeIn(prompt: string): string {
  const match = /(\S+?)[\\/]\.grampus[\\/]/.exec(prompt);
  if (!match?.[1]) throw new Error(`No worktree in prompt:\n${prompt}`);
  return match[1];
}

/** Good workers. The `alt` entry's spec also requires an acceptance test its builder adds. */
function workers(): Behaviour {
  return async context => {
    const isAlt = context.title.includes('[alt]');
    switch (roleOf(context.title)) {
      case 'spec': {
        const checks = [{ name: 'greet', command: checkCommand }];
        if (isAlt) checks.push({ name: 'extra', command: extraCheck });
        writeFileSync(outputPath(context.spec), specText(checks));
        return { outcome: 'succeeded' };
      }
      case 'spec-review':
      case 'review':
        writeFileSync(outputPath(context.spec), reviewJson('approve'));
        return { outcome: 'succeeded' };
      case 'tests': {
        const worktree = worktreeIn(context.spec);
        const path = join(worktree, 'test/greet.test.js');
        writeFileSync(path, readFileSync(path, 'utf8') + "if (greet('Bo') !== 'Hello, Bo!') process.exit(1);\n");
        await commitAll(worktree, 'Extend shared acceptance tests');
        writeFileSync(
          outputPath(context.spec),
          JSON.stringify({
            failures: [{ check: 'greet', criterion: 'Greet by name', expectedOutput: 'greet failed: Hi' }],
          }),
        );
        return { outcome: 'succeeded' };
      }
      case 'build':
      case 'repair': {
        const worktree = worktreeIn(context.spec);
        write(worktree, 'greet.js', 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
        if (isAlt)
          write(
            worktree,
            'test/extra.test.js',
            "import { greet } from '../greet.js';\nif (greet('Bo') !== 'Hello, Bo!') process.exit(1);\n",
          );
        await commitAll(worktree, 'Greet by name');
        return { outcome: 'succeeded' };
      }
      default:
        return { outcome: 'succeeded' };
    }
  };
}

interface Run {
  dataDir: string;
  repo: string;
  comparisonId: string;
  driver: Promise<number>;
  comparison(): ComparisonState;
  entry(index: number): TaskState;
  until<T>(read: () => T | null | undefined | false, what: string): Promise<T>;
  /** Exit codes of the entry drivers started so far. */
  entryDrivers: Promise<number>[];
}

async function startRun(mode: 'shared' | 'full', concurrency: number, sharedTests = false): Promise<Run> {
  const leader: Recipe = { ...pipelineRecipe, name: 'with-tests', testsFirst: { agent: 'codex' } };
  useTestSettings({
    recipes: sharedTests ? [alt, leader] : [pipelineRecipe, alt],
    comparisonConcurrency: concurrency,
    waitPollMs: 20,
  });
  const repo = await createRepository();
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-compare-'));
  const desk = new FakeOrca(() => 'hang');
  const created = await startComparison(
    {
      dataDir,
      repoPath: repo,
      request: 'Make greet say hello by name.',
      title: 'Greet',
      recipeNames: [sharedTests ? 'with-tests' : pipelineRecipe.name, 'alt'],
      mode,
      driveCommand: id => `compare ${id}`,
    },
    desk,
  );
  assert.deepEqual(
    desk.terminalPlaces,
    [`path:${created.repository}`],
    "the comparison driver runs in the repository's checkout",
  );
  const store = ComparisonStore.open(dataDir, created.comparisonId);
  const comparison = () => foldComparison(store.events());
  const entryDrivers: Promise<number>[] = [];
  const started = new Set<string>();
  const run: Run = {
    dataDir,
    repo,
    comparisonId: created.comparisonId,
    driver: driveComparison({
      dataDir,
      comparisonId: created.comparisonId,
      orca: desk,
      selfCommand: 'grampus',
      log: () => undefined,
    }),
    comparison,
    entry: index => {
      const taskId = comparison().entries[index]?.taskId;
      if (!taskId) throw new Error(`No entry ${index} yet.`);
      return foldEvents(TaskStore.open(dataDir, taskId).events());
    },
    until: async (read, what) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        // Start a driver for every new entry, as its Orca terminal would; each has its own Orca.
        for (const entry of comparison().entries)
          if (!started.has(entry.taskId)) {
            started.add(entry.taskId);
            entryDrivers.push(drive(TaskStore.open(dataDir, entry.taskId), new FakeOrca(workers()), () => undefined));
          }
        const value = read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await sleep(15);
      }
    },
    entryDrivers,
  };
  return run;
}

const tryEntry = (run: Run, index: number) => (run.comparison().entries[index] ? run.entry(index) : null);

test('a full comparison runs every recipe end to end, cross-checks the results and keeps the pick', async () => {
  const run = await startRun('full', 2);
  await run.until(() => run.comparison().entries.length === 2, 'both entries');
  for (const index of [0, 1]) {
    await run.until(() => tryEntry(run, index)?.attention?.reason === 'approve-spec:1', `entry ${index} spec`);
    queueCommand(run.dataDir, run.entry(index).taskId, 'cli', { kind: 'approve', specVersion: 1 });
  }
  const [first, second] = [run.entry(0), run.entry(1)];
  assert.equal(first.workspace?.baseSha, second.workspace?.baseSha, 'every entry starts from the same commit');
  assert.equal(run.comparison().baseSha, first.workspace?.baseSha);

  const asked = await run.until(
    () => (run.comparison().attention?.reason === 'pick' ? run.comparison() : null),
    'pick',
  );
  const cells = asked.crossCheck ?? [];
  assert.equal(cells.length, 4, 'every spec against every result');
  const recorded = ComparisonStore.open(run.dataDir, run.comparisonId).events();
  assert.equal(
    recorded.filter(event => event.type === 'cross_check.cell').length,
    4,
    'each cell is recorded as it finishes, so progress shows and a restart resumes',
  );
  assert.ok(cells.every(cell => cell.incompatible?.length === 0));
  const standardOnAlt = cells.find(cell => cell.specOf === first.taskId && cell.candidate === second.taskId);
  const altOnStandard = cells.find(cell => cell.specOf === second.taskId && cell.candidate === first.taskId);
  assert.deepEqual(
    standardOnAlt?.results?.map(result => [result.name, result.passed]),
    [['greet', true]],
  );
  // The alt spec's acceptance test was overlaid on the standard entry's commit, and passed there too.
  assert.deepEqual(
    altOnStandard?.results?.map(result => [result.name, result.passed]),
    [
      ['greet', true],
      ['extra', true],
    ],
  );
  const standardWorktree = first.workspace?.path ?? '';
  assert.equal(existsSync(join(standardWorktree, 'test', 'extra.test.js')), false, 'the overlay was removed');
  assert.deepEqual(await uncommittedPaths(standardWorktree), [], 'the candidate worktree is clean again');

  queueComparisonCommand(run.dataDir, run.comparisonId, 'dashboard', { kind: 'pick', taskId: second.taskId });
  assert.equal(await run.driver, 0);
  await Promise.all(run.entryDrivers);
  assert.equal(run.entry(1).finished?.outcome, 'accepted');
  assert.equal(run.entry(0).finished?.outcome, 'not-selected');
  assert.ok(run.entry(0).measurements, 'a declined entry is still measured');
  assert.deepEqual(
    run.comparison().finished && [run.comparison().finished?.outcome, run.comparison().finished?.winner],
    ['picked', second.taskId],
  );
});

test('a shared comparison writes one spec, waits for a free place, and builds the other recipe from it', async () => {
  const run = await startRun('shared', 1);
  await run.until(() => tryEntry(run, 0)?.attention?.reason === 'approve-spec:1', 'the shared spec');
  assert.equal(run.comparison().entries.length, 1, 'the other recipe waits for the approved spec');
  queueCommand(run.dataDir, run.entry(0).taskId, 'cli', { kind: 'approve', specVersion: 1 });
  await run.until(() => run.comparison().sharedSpec, 'the spec to be shared');
  await run.until(() => tryEntry(run, 0)?.attention?.reason === 'ready:0', 'the first entry to finish its rounds');
  const second = await run.until(() => {
    const entry = tryEntry(run, 1);
    return entry?.attention?.reason === 'ready:0' ? entry : null;
  }, 'the second entry, once a place was free');

  assert.deepEqual(second.inherited, { fromTask: run.entry(0).taskId, fromVersion: 1 });
  assert.equal(second.gate, null, 'an inherited spec needs no approval gate');
  assert.ok(![...second.stages.keys()].some(key => key.startsWith('spec')), 'the second entry ran no spec stage');
  assert.equal(second.recipe.name, 'alt');

  await run.until(() => run.comparison().attention?.reason === 'pick', 'the comparison to ask for a pick');
  queueComparisonCommand(run.dataDir, run.comparisonId, 'cli', { kind: 'pick', taskId: run.entry(0).taskId });
  assert.equal(await run.driver, 0);
  await Promise.all(run.entryDrivers);
  assert.equal(run.entry(1).finished?.outcome, 'not-selected');
  assert.equal(run.comparison().crossCheck, null, 'shared mode has one spec, so no cross-check');
});

test('a pick of an entry that is not waiting for acceptance is refused', async () => {
  const run = await startRun('full', 2);
  await run.until(() => tryEntry(run, 0)?.attention?.reason === 'approve-spec:1', 'first spec');
  queueComparisonCommand(run.dataDir, run.comparisonId, 'cli', { kind: 'pick', taskId: run.entry(0).taskId });
  await run.until(() => run.comparison().applied.size === 1, 'the pick to be handled');
  assert.equal(run.comparison().decision, null);
  queueComparisonCommand(run.dataDir, run.comparisonId, 'cli', { kind: 'abandon' });
  assert.equal(await run.driver, 0);
  await Promise.all(run.entryDrivers);
  assert.equal(run.comparison().finished?.outcome, 'abandoned');
  assert.ok(run.comparison().entries.every((_, index) => run.entry(index).finished?.outcome === 'abandoned'));
});

test('a pick sent before the comparison asks for one is refused, not applied later', async () => {
  const run = await startRun('full', 2);
  await run.until(() => run.comparison().entries.length === 2, 'both entries');
  await run.until(() => tryEntry(run, 0)?.attention?.reason === 'approve-spec:1', 'first spec');
  queueCommand(run.dataDir, run.entry(0).taskId, 'cli', { kind: 'approve', specVersion: 1 });
  await run.until(() => tryEntry(run, 0)?.attention?.reason === 'ready:0', 'the first entry to finish its rounds');
  queueComparisonCommand(run.dataDir, run.comparisonId, 'dashboard', { kind: 'pick', taskId: run.entry(0).taskId });
  await run.until(() => run.comparison().applied.size === 1, 'the early pick to be handled');
  assert.equal(run.comparison().decision, null);
  assert.match(run.comparison().refused?.reason ?? '', /has not asked for a pick yet/);
  assert.match(renderComparison(summariseComparison(run.dataDir, run.comparisonId)), /Refused pick: /);

  await run.until(() => tryEntry(run, 1)?.attention?.reason === 'approve-spec:1', 'second spec');
  queueCommand(run.dataDir, run.entry(1).taskId, 'cli', { kind: 'approve', specVersion: 1 });
  await run.until(() => run.comparison().attention?.reason === 'pick', 'the comparison to ask for a pick');
  queueComparisonCommand(run.dataDir, run.comparisonId, 'dashboard', { kind: 'pick', taskId: run.entry(1).taskId });
  assert.equal(await run.driver, 0);
  await Promise.all(run.entryDrivers);
  assert.equal(run.comparison().finished?.winner, run.entry(1).taskId);
});

test('the comparison status shows a running cross-check', () => {
  const shown = renderComparison({
    comparisonId: 'cmp-x',
    title: 'X',
    mode: 'full',
    entries: [],
    waiting: [],
    crossCheck: { done: 23, total: 36 },
    needsYou: null,
    refused: null,
    finished: null,
    lastStop: null,
  });
  assert.match(shown, /cross-check running: 23 of 36 cells/);
});

test('a check whose copied tests do not compile against the candidate is incompatible, not just failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grampus-incompatible-'));
  const result = (name: string, text: string, passed = false) => {
    const logPath = join(dir, `${name}.log`);
    writeFileSync(logPath, text);
    return {
      name,
      command: name,
      exitCode: passed ? 0 : 1,
      timedOut: false,
      durationMs: 1,
      logPath,
      flaky: false,
      passed,
    };
  };
  const results = [
    result(
      'dotnet',
      "Tests.cs(84,60): error CS1739: The best overload for 'QuickUnlockRequest' does not have a parameter named 'RestOfDay'",
    ),
    result('node', "SyntaxError: The requested module '../greet.js' does not provide an export named 'greetAll'"),
    result('vitest', 'AssertionError: expected false to be true'),
    result('passing', 'error CS0000 mentioned in a passing log', true),
  ];
  assert.deepEqual(incompatibleChecks(results), ['dotnet', 'node']);
});

test('a task outside a comparison refuses decline', async () => {
  useTestSettings();
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-decline-'));
  const store = TaskStore.create(dataDir, 'solo');
  store.append({
    type: 'task.created',
    taskId: 'solo',
    title: 'T',
    request: 'R',
    repoPath: dataDir,
    recipe: pipelineRecipe,
  });
  queueCommand(dataDir, 'solo', 'cli', { kind: 'decline' });
  const { DriverCore } = await import('../src/pipeline/driver-core.js');
  const core = new DriverCore(store, new FakeOrca(() => 'hang'), () => undefined);
  await core.pump();
  const refused = store.events().find(event => event.type === 'command.refused');
  assert.equal(refused?.type === 'command.refused' && refused.reason, 'only a comparison entry can be declined');
});

test('estimated cost prices each model, and stays unknown without a price or a per-model split', () => {
  const usage = { input: 1_000_000, cachedInput: 2_000_000, cacheWrite: 0, output: 100_000, reasoning: null };
  const prices = { a: { input: 2, cachedInput: 0.1, cacheWrite: 0, output: 10 } };
  assert.deepEqual(estimateCost({ models: ['a'], usage }, prices), { usd: 3.2, note: null });
  assert.equal(estimateCost({ models: ['b'], usage }, prices).usd, null);
  assert.match(estimateCost({ models: ['a', 'b'], usage }, prices).note ?? '', /cannot be split/);
  const split = { a: usage, b: usage };
  assert.match(estimateCost({ models: ['a', 'b'], usage, usageByModel: split }, prices).note ?? '', /no price for b/);
});

test('shared mode distributes the same protected acceptance-test commit', async () => {
  const run = await startRun('shared', 2, true);
  try {
    await run.until(() => tryEntry(run, 0)?.attention?.reason === 'approve-spec:1', 'first spec');
    queueCommand(run.dataDir, run.entry(0).taskId, 'cli', { kind: 'approve', specVersion: 1 });
    await run.until(() => tryEntry(run, 1)?.attention?.reason === 'ready:0', 'shared tests built');
    assert.deepEqual(run.entry(1).testsFirst, run.entry(0).testsFirst);
    assert.deepEqual(run.entry(1).testsFirst?.files, ['test/greet.test.js']);
    assert.equal(run.entry(1).stages.has('tests:0'), false);
    assert.equal(run.entry(1).baseline?.results[0]?.passed, false);
    assert.equal(run.entry(1).verify.get(0)?.results[0]?.passed, true);
  } finally {
    queueComparisonCommand(run.dataDir, run.comparisonId, 'cli', { kind: 'abandon' });
    await run.driver;
    await Promise.all(run.entryDrivers);
  }
});
