import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { headSha } from '../src/git/git.js';
import { renderSummary, summarise } from '../src/pipeline/status.js';
import {
  commitAll,
  createHarness,
  goodWorkers,
  outputPath,
  roleOf,
  specText,
  worktreeOf,
  write,
} from './helpers/task-fixture.js';

test('a task runs spec, approval, baseline, build, verify and review to acceptance', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();

  const awaiting = await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  assert.equal(awaiting.specs.length, 1);
  assert.equal(awaiting.specReviews.get(1)?.report?.verdict, 'approve');
  assert.ok(awaiting.gate, 'the approval gate exists in Orca');
  // Whoever relays the approval (a chat agent or the terminal) must be able to show the spec itself.
  const shown = renderSummary(summarise(awaiting));
  assert.match(shown, /greet\('Ada'\) returns 'Hello, Ada!'/, 'the spec text is part of the approval request');
  assert.match(shown, /spec review: approve/);
  harness.command({ kind: 'approve', specVersion: 1 });

  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready to accept');
  assert.equal(ready.baseline?.results[0]?.passed, false, 'the check fails before the change');
  assert.equal(ready.verify.get(0)?.results[0]?.passed, true);
  assert.deepEqual(ready.guard.get(0)?.guard.violations, []);
  assert.equal(ready.reviews.get(0)?.report?.verdict, 'approve');
  assert.equal(ready.decisions.get(0)?.decision, 'ready');
  harness.command({ kind: 'accept' });

  assert.equal(await driver, 0);
  const finished = harness.state();
  assert.equal(finished.finished?.outcome, 'accepted');
  assert.equal(finished.finished?.override, false);
  assert.equal(finished.finished?.sha, await headSha(finished.workspace?.path ?? ''));

  const roles = harness.orca.starts.map(start => [roleOf(start.title), start.request.assignment?.agent]);
  assert.deepEqual(roles, [
    ['spec', 'claude'],
    ['spec-review', 'codex'],
    ['build', 'codex'],
    ['review', 'claude'],
  ]);
  assert.equal(harness.orca.gates.get('gate_1'), 'approve');
  assert.deepEqual(harness.orca.released.sort(), harness.orca.starts.map((_, index) => `dispatch_${index + 1}`).sort());
  assert.ok(existsSync(finished.specs[0]?.path ?? ''), 'the approved spec is kept in the task folder');
});

test('a revision continues the spec writer and needs approval of the new version', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'first approval');
  harness.command({ kind: 'approve', specVersion: 2 });
  harness.command({ kind: 'revise', feedback: 'Also greet in French.' });
  await harness.until(state => state.attention?.reason === 'approve-spec:2', 'second approval');

  const state = harness.state();
  const refused = harness.store.events().filter(event => event.type === 'command.refused');
  assert.equal(refused.length, 1, 'approving a version that does not exist yet is refused');
  const revision = harness.orca.starts.find(start => start.title.startsWith('Spec revision'));
  assert.equal(revision?.request.terminal, 'term_dispatch_1', 'the revision continues the first conversation');
  assert.match(harness.orca.starts[2]?.title ?? '', /Spec revision 1/);
  assert.equal(state.specs.length, 2);

  harness.command({ kind: 'abandon', reason: 'enough' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.outcome, 'abandoned');
});

test('an unusable spec file is corrected automatically once', async () => {
  let attempts = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        attempts++;
        writeFileSync(outputPath(context.spec), attempts === 1 ? '# No block here\n' : specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const state = await harness.until(s => s.attention?.reason === 'approve-spec:1', 'approval after correction');
  assert.equal(attempts, 2);
  assert.match(state.rejectedSpecs.get('spec:1') ?? '', /exactly one fenced/);
  assert.match(harness.orca.starts.find(start => start.title.startsWith('Spec revision'))?.title ?? '', /revision/);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('tests first commits acceptance tests that the builder may not change', async () => {
  const recipe = { ...standardRecipe, name: 'tests-first', testsFirst: { agent: 'claude' as const } };
  let builds = 0;
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        tests: async () => {
          const worktree = worktreeOf(h);
          write(
            worktree,
            'test/accept.test.js',
            "import { greet } from '../greet.js';\nif (greet('Bo') !== 'Hello, Bo!') process.exit(1);\n",
          );
          await commitAll(worktree, 'Add acceptance tests');
          return { outcome: 'succeeded' };
        },
        build: async () => {
          builds++;
          const worktree = worktreeOf(h);
          write(worktree, 'greet.js', 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
          write(worktree, 'test/accept.test.js', 'process.exit(0);\n');
          await commitAll(worktree, 'Greet and weaken the acceptance test');
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const decided = await harness.until(state => state.decisions.has(0), 'round 0 decision');
  assert.deepEqual(decided.testsFirst?.files, ['test/accept.test.js']);
  assert.match(
    decided.guard.get(0)?.guard.violations.join() ?? '',
    /Protected path changed \(M\): test\/accept.test.js/,
  );
  assert.equal(decided.decisions.get(0)?.decision, 'repair');
  assert.equal(builds, 1);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('acceptance warns when the checks already passed before the change', async () => {
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        writeFileSync(outputPath(context.spec), specText([{ name: 'always', command: 'node -e "process.exit(0)"' }]));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  assert.match(ready.attention?.detail ?? '', /every check also passed before the change/);
  harness.command({ kind: 'accept' });
  await driver;
  const measured = harness.state().measurements ?? [];
  assert.equal(measured.length, 4, 'every dispatch is measured when the task finishes');
  assert.equal(measured[0]?.note, 'no provider session found', 'the fake has no transcripts: unknown, not zero');
  assert.equal(measured[0]?.usage, null);
});
