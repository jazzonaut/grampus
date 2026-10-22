import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe, type Recipe } from '../src/domain/recipe.js';
import { headSha } from '../src/git/git.js';
import type { WorkerContext, WorkerResult } from './helpers/fake-orca.js';
import {
  commitAll,
  createHarness,
  goodWorkers,
  outputPath,
  readText,
  reviewJson,
  write,
  worktreeOf,
  type Harness,
} from './helpers/task-fixture.js';

const recipe: Recipe = { ...standardRecipe, name: 'simplify', simplify: { agent: 'codex' } };

const plainGreet = 'export const greet = name => `Hello, ${name}!`;\n';

async function approveAndWait(harness: Harness, reason: string) {
  await harness.until(
    state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1),
    'spec approval',
  );
  harness.command({ kind: 'approve', specVersion: 1 });
  return harness.until(state => state.attention?.reason === reason, reason);
}

/** A simplifier that rewrites `greet.js` (and optionally more files) and commits. */
function simplifier(h: Harness, files: Record<string, string> = { 'greet.js': plainGreet }, result?: WorkerResult) {
  return async (_context: WorkerContext): Promise<WorkerResult> => {
    const worktree = worktreeOf(h);
    for (const [path, text] of Object.entries(files)) write(worktree, path, text);
    await commitAll(worktree, 'Simplify greet');
    return result ?? { outcome: 'succeeded' };
  };
}

test('a simplification that passes the checks and its review is kept and accepted', async () => {
  const harness = await createHarness(h => goodWorkers(h, { simplify: simplifier(h) }), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');

  const simplified = ready.simplify.get(0);
  assert.equal(simplified?.decided?.kept, true, simplified?.decided?.reasons.join('; '));
  assert.equal(simplified.decided.fromSha, ready.verify.get(0)?.sha);
  assert.notEqual(simplified.decided.sha, simplified.decided.fromSha);
  assert.ok(simplified.decided.after.added < simplified.decided.before.added, 'the change got smaller');
  assert.equal(simplified.checked?.results[0]?.passed, true);
  assert.equal(simplified.decided.review?.report?.verdict, 'approve');
  assert.match(ready.attention?.detail ?? '', /Simplified at /);
  const review = harness.orca.starts.find(start => start.title.startsWith('Simplify review 0'));
  assert.match(review?.spec ?? '', new RegExp(`git diff ${simplified.decided.fromSha} ${simplified.decided.sha}`));
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.sha, simplified.decided.sha);
});

test('a simplification that breaks a check is discarded and the worktree goes back to the verified commit', async () => {
  const broken = "export function greet() {\n  return 'Hi';\n}\n";
  const harness = await createHarness(h => goodWorkers(h, { simplify: simplifier(h, { 'greet.js': broken }) }), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');

  const decided = ready.simplify.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.match(decided.reasons.join(), /check "greet" failed/);
  assert.equal(await headSha(worktreeOf(harness)), decided.fromSha);
  assert.ok(!harness.orca.starts.some(start => start.title.startsWith('Simplify review')), 'no review of a failure');
  assert.match(ready.attention?.detail ?? '', /Simplification discarded: check "greet" failed/);
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.sha, decided.fromSha);
  assert.equal(harness.state().finished?.override, false);
});

test('anything but an approving review of the simplification discards it', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        simplify: simplifier(h),
        'simplify-review': context => {
          writeFileSync(outputPath(context.spec), reviewJson('unknown'));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.simplify.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.deepEqual(decided.reasons, ['review verdict unknown']);
  assert.equal(await headSha(worktreeOf(harness)), decided.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('a simplifier that reports failure after committing is discarded without asking the user', async () => {
  const harness = await createHarness(
    h => goodWorkers(h, { simplify: simplifier(h, undefined, { outcome: 'failed', body: 'Gave up halfway.' }) }),
    recipe,
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.simplify.get(0)?.decided;
  assert.match(decided?.reasons.join() ?? '', /reported failure: Gave up halfway/);
  assert.notEqual(decided?.sha, decided?.fromSha, 'the discarded commit is kept as evidence');
  assert.equal(await headSha(worktreeOf(harness)), decided?.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('a simplifier that changes nothing leaves the verified commit', async () => {
  const harness = await createHarness(h => goodWorkers(h), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.simplify.get(0)?.decided;
  assert.deepEqual(decided?.reasons, ['the simplifier changed nothing']);
  assert.equal(decided.sha, decided.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('tests the simplifier adapts are named to its reviewer, and discard it when there is no reviewer', async () => {
  // Not the file the check runs: that one is check configuration, which the simplifier may never change.
  const testFile = 'test/format.test.js';
  const workers = (h: Harness) =>
    goodWorkers(h, {
      build: async () => {
        const worktree = worktreeOf(h);
        write(worktree, 'greet.js', 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
        write(worktree, testFile, "import { greet } from '../greet.js';\nconsole.log(greet('Ada'));\n");
        await commitAll(worktree, 'Greet by name');
        return { outcome: 'succeeded' };
      },
      simplify: async () => {
        const worktree = worktreeOf(h);
        write(worktree, 'greet.js', plainGreet);
        write(worktree, testFile, `// adapted\n${readText(`${worktree}/${testFile}`)}`);
        await commitAll(worktree, 'Simplify greet and adapt its test');
        return { outcome: 'succeeded' };
      },
    });

  const reviewed = await createHarness(workers, recipe);
  let driver = reviewed.run();
  let ready = await approveAndWait(reviewed, 'ready:0');
  assert.equal(ready.simplify.get(0)?.decided?.kept, true, ready.simplify.get(0)?.decided?.reasons.join('; '));
  const review = reviewed.orca.starts.find(start => start.title.startsWith('Simplify review 0'));
  assert.match(review?.spec ?? '', /Tests the simplification modified[\s\S]*test\/format\.test\.js/);
  reviewed.command({ kind: 'accept' });
  await driver;

  const unreviewed = await createHarness(workers, { ...recipe, name: 'simplify-unreviewed', review: null });
  driver = unreviewed.run();
  ready = await approveAndWait(unreviewed, 'ready:0');
  const decided = ready.simplify.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.match(
    decided.reasons.join(),
    /tests changed with no review to confirm they were only adapted: test\/format\.test\.js/,
  );
  assert.equal(await headSha(worktreeOf(unreviewed)), decided.fromSha);
  unreviewed.command({ kind: 'accept' });
  await driver;
});

test('a round after a kept simplification starts from the simplified commit and is simplified again', async () => {
  const harness = await createHarness(h => goodWorkers(h, { simplify: simplifier(h) }), recipe);
  const driver = harness.run();
  const first = await approveAndWait(harness, 'ready:0');
  const simplified = first.simplify.get(0)?.decided;
  assert.equal(simplified?.kept, true);
  harness.command({ kind: 'continue', guidance: 'Add a comment.' });
  const second = await harness.until(state => state.attention?.reason === 'ready:1', 'ready after continue');
  assert.equal(second.guard.get(1)?.fromSha, simplified.sha);
  assert.ok(second.simplify.get(1)?.decided, 'every ready round gets a simplify pass');
  harness.command({ kind: 'accept' });
  await driver;
});

test('a recipe without simplify runs no simplify stage', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  assert.equal(ready.simplify.size, 0);
  assert.ok(!harness.orca.starts.some(start => start.title.startsWith('Simplify')));
  harness.command({ kind: 'accept' });
  await driver;
});

test('a driver that dies during the simplify review resumes without simplifying or checking again', async () => {
  let release = () => {};
  const reviewed = new Promise<void>(resolve => (release = resolve));
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        simplify: simplifier(h),
        'simplify-review': async context => {
          await reviewed;
          writeFileSync(outputPath(context.spec), reviewJson('approve'));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const first = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1), 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(state => state.stages.has('simplify-review:0'), 'the simplify review');
  harness.orca.failNextCheck = true;
  assert.equal(await first, 1);

  release();
  const second = harness.run();
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready after resuming');
  assert.equal(ready.simplify.get(0)?.decided?.kept, true);
  const titles = harness.orca.starts.map(start => start.title);
  assert.equal(titles.filter(title => title.startsWith('Simplify 0')).length, 1);
  assert.equal(titles.filter(title => title.startsWith('Simplify review 0')).length, 1);
  const checked = harness.store.events().filter(event => event.type === 'simplify.checked');
  assert.equal(checked.length, 1, 'the checks of the simplified commit ran once');
  harness.command({ kind: 'accept' });
  assert.equal(await second, 0);
});
