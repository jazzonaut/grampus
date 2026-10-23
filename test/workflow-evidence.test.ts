// Regressions from the installed Snake comparison: existing tests and the post-polish candidate.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { crossCheckCell } from '../src/compare/cross-check.js';
import { ComparisonStore } from '../src/compare/comparison.js';
import {
  commitAll,
  createHarness,
  goodWorkers,
  readText,
  worktreeOf,
  write,
  outputPath,
  polishReportJson,
  specText,
} from './helpers/task-fixture.js';

test('tests first recognises and protects cases added to existing test files', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        tests: async () => {
          const cwd = worktreeOf(h);
          write(
            cwd,
            'test/greet.test.js',
            readText(`${cwd}/test/greet.test.js`) + "if (greet('Bo') !== 'Hello, Bo!') process.exit(1);\n",
          );
          await commitAll(cwd, 'Extend existing acceptance tests');
          return { outcome: 'succeeded' };
        },
      }),
    { ...standardRecipe, name: 'existing-tests', testsFirst: { agent: 'codex' } },
  );
  const driver = harness.run();
  try {
    await harness.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    harness.command({ kind: 'approve', specVersion: 1 });
    const state = await harness.until(
      s => s.attention?.reason === 'tests-failed' || s.attention?.reason === 'ready:0',
      'test evidence',
    );
    assert.deepEqual(state.testsFirst?.files, ['test/greet.test.js']);
    assert.equal(state.attention?.reason, 'ready:0');
    const prompt = harness.orca.starts.find(s => s.title.startsWith('Review 0'))?.spec ?? '';
    assert.match(prompt, /test\/greet.test.js/);
    assert.match(prompt, new RegExp(state.workspace?.baseSha ?? 'missing'));
  } finally {
    harness.command({ kind: 'abandon' });
    await driver;
  }
});

test('cross-checks use the retained polish and its own check evidence', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: async context => {
          write(worktreeOf(h), 'greet.js', 'export const greet = name => `Hello, ${name}!`;\n');
          await commitAll(worktreeOf(h), 'Polish greeting');
          writeFileSync(outputPath(context.spec), polishReportJson());
          return { outcome: 'succeeded' };
        },
      }),
    { ...standardRecipe, name: 'polished-candidate', polish: { agent: 'codex' } },
  );
  const driver = harness.run();
  try {
    await harness.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    harness.command({ kind: 'approve', specVersion: 1 });
    const state = await harness.until(s => s.attention?.reason === 'ready:0', 'ready');
    const store = ComparisonStore.create(harness.dataDir, 'cmp-evidence');
    const sha = state.polish.get(0)?.decided?.sha;
    const own = await crossCheckCell(store, state, state, state.workspace?.baseSha ?? '', () => {});
    assert.equal(own.sha, sha);
    const external = await crossCheckCell(
      store,
      { ...state, taskId: 'other' },
      state,
      state.workspace?.baseSha ?? '',
      () => {},
    );
    assert.equal(external.error, null);
    assert.equal(external.sha, sha);
    assert.ok(external.results?.every(check => check.passed));
  } finally {
    harness.command({ kind: 'abandon' });
    await driver;
  }
});

test('repository setup fails separately, retries explicitly and precedes the spec', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        spec: context => {
          assert.ok(existsSync(`${worktreeOf(h)}/.prepared`));
          writeFileSync(outputPath(context.spec), specText());
          return { outcome: 'succeeded' };
        },
      }),
    standardRecipe,
    async repo => {
      write(repo, '.gitignore', '.allow-setup\n.prepared\n');
      write(
        repo,
        'setup.js',
        "import fs from 'node:fs'; if (!fs.existsSync('.allow-setup')) process.exit(1); fs.writeFileSync('.prepared', 'yes');\n",
      );
      write(repo, 'grampus.json', JSON.stringify({ setup: { name: 'Prepare', command: 'node setup.js' } }));
      await commitAll(repo, 'Configure repository preparation');
    },
  );
  const driver = harness.run();
  try {
    const failed = await harness.until(s => s.attention?.reason === 'setup-failed:1', 'setup failure');
    assert.equal(failed.specChecks.size, 0);
    assert.equal(harness.orca.starts.length, 0, 'no worker starts with a broken environment');
    write(worktreeOf(harness), '.allow-setup', 'yes');
    harness.command({ kind: 'retry' });
    const prepared = await harness.until(s => s.attention?.reason === 'approve-spec:1', 'spec after setup');
    assert.equal(prepared.setup.results.length, 2);
    assert.equal(prepared.setup.results[1]?.result.passed, true);
  } finally {
    harness.command({ kind: 'abandon' });
    await driver;
  }
});

test('a tests-first worker cannot quietly implement production code', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        tests: async () => {
          write(worktreeOf(h), 'greet.js', 'export const greet = () => "changed";');
          await commitAll(worktreeOf(h), 'Implement during tests');
          return { outcome: 'succeeded' };
        },
      }),
    { ...standardRecipe, name: 'test-boundary', testsFirst: { agent: 'codex' } },
  );
  const driver = harness.run();
  await harness.until(s => s.attention?.reason === 'approve-spec:1', 'spec');
  harness.command({ kind: 'approve', specVersion: 1 });
  assert.equal(await driver, 1);
  assert.match(harness.state().lastStop?.reason ?? '', /non-test files/);
  assert.equal(harness.state().stages.has('build:0'), false);
});

test('acceptance refuses a commit added after final verification', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  await harness.until(s => s.attention?.reason === 'approve-spec:1', 'spec');
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(s => s.attention?.reason === 'ready:0', 'ready');
  write(worktreeOf(harness), 'extra.txt', 'unverified');
  await commitAll(worktreeOf(harness), 'Move past verification');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 1);
  assert.equal(harness.state().finished, null);
  assert.match(harness.state().lastStop?.reason ?? '', /final checked candidate/);
});
