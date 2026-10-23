import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe, type Recipe } from '../src/domain/recipe.js';
import { headSha, uncommittedPaths } from '../src/git/git.js';
import type { WorkerContext, WorkerResult } from './helpers/fake-orca.js';
import {
  commitAll,
  createHarness,
  goodWorkers,
  outputPath,
  readText,
  polishReportJson,
  polishReviewJson,
  write,
  worktreeOf,
  type Harness,
} from './helpers/task-fixture.js';

const recipe: Recipe = { ...standardRecipe, name: 'polish', polish: { agent: 'codex' } };

const plainGreet = 'export const greet = name => `Hello, ${name}!`;\n';

async function approveAndWait(harness: Harness, reason: string) {
  await harness.until(
    state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1),
    'spec approval',
  );
  harness.command({ kind: 'approve', specVersion: 1 });
  return harness.until(state => state.attention?.reason === reason, reason);
}

/** A polisher that rewrites `greet.js` (and optionally more files) and commits. */
function polisher(h: Harness, files: Record<string, string> = { 'greet.js': plainGreet }, result?: WorkerResult) {
  return async (context: WorkerContext): Promise<WorkerResult> => {
    const worktree = worktreeOf(h);
    for (const [path, text] of Object.entries(files)) write(worktree, path, text);
    await commitAll(worktree, 'Polish greet');
    writeFileSync(outputPath(context.spec), polishReportJson(Object.keys(files)));
    return result ?? { outcome: 'succeeded' };
  };
}

test('a polish that passes the checks and its review is kept and accepted', async () => {
  const harness = await createHarness(h => goodWorkers(h, { polish: polisher(h) }), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');

  const polished = ready.polish.get(0);
  assert.equal(polished?.decided?.kept, true, polished?.decided?.reasons.join('; '));
  assert.equal(polished.decided.fromSha, ready.verify.get(0)?.sha);
  assert.notEqual(polished.decided.sha, polished.decided.fromSha);
  assert.ok(polished.decided.after.added < polished.decided.before.added, 'the change got smaller');
  assert.equal(polished.checked?.results[0]?.passed, true);
  assert.equal(polished.decided.review?.report?.verdict, 'approve');
  assert.match(ready.attention?.detail ?? '', /Polished at /);
  const review = harness.orca.starts.find(start => start.title.startsWith('Polish review 0'));
  assert.match(review?.spec ?? '', new RegExp(`git diff ${polished.decided.fromSha} ${polished.decided.sha}`));
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.sha, polished.decided.sha);
});

test('a polish that breaks a check is discarded and the worktree goes back to the verified commit', async () => {
  const broken = "export function greet() {\n  return 'Hi';\n}\n";
  const harness = await createHarness(h => goodWorkers(h, { polish: polisher(h, { 'greet.js': broken }) }), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');

  const decided = ready.polish.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.match(decided.reasons.join(), /check "greet" failed/);
  assert.equal(await headSha(worktreeOf(harness)), decided.fromSha);
  assert.ok(!harness.orca.starts.some(start => start.title.startsWith('Polish review')), 'no review of a failure');
  assert.match(ready.attention?.detail ?? '', /Polish discarded: check "greet" failed/);
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.sha, decided.fromSha);
  assert.equal(harness.state().finished?.override, false);
});

test('anything but an approving review of the polish discards it', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: polisher(h),
        'polish-review': context => {
          writeFileSync(
            outputPath(context.spec),
            JSON.stringify({
              verdict: 'unknown',
              summary: 'Cannot establish equivalence.',
              findings: [],
              maintenance: { verdict: 'unknown', rationale: 'Equivalence uncertain.' },
            }),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.polish.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.deepEqual(decided.reasons, ['review verdict unknown', 'maintenance benefit: unknown']);
  assert.equal(await headSha(worktreeOf(harness)), decided.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('a polisher that reports failure after committing is discarded without asking the user', async () => {
  const harness = await createHarness(
    h => goodWorkers(h, { polish: polisher(h, undefined, { outcome: 'failed', body: 'Gave up halfway.' }) }),
    recipe,
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.polish.get(0)?.decided;
  assert.match(decided?.reasons.join() ?? '', /reported failure: Gave up halfway/);
  assert.notEqual(decided?.sha, decided?.fromSha, 'the discarded commit is kept as evidence');
  assert.equal(await headSha(worktreeOf(harness)), decided?.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('a polisher that changes nothing leaves the verified commit', async () => {
  const harness = await createHarness(h => goodWorkers(h), recipe);
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  const decided = ready.polish.get(0)?.decided;
  assert.equal(decided?.outcome, 'noop');
  assert.deepEqual(decided.reasons, []);
  assert.equal(decided.sha, decided.fromSha);
  harness.command({ kind: 'accept' });
  await driver;
});

test('a failed polish restores uncommitted edits even when HEAD never moved', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: () => {
          write(worktreeOf(h), 'greet.js', 'unfinished edit');
          write(worktreeOf(h), 'unfinished.txt', 'untracked edit');
          return { outcome: 'failed', body: 'Interrupted before committing.' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  try {
    const ready = await approveAndWait(harness, 'ready:0');
    assert.equal(ready.polish.get(0)?.decided?.outcome, 'discarded');
    assert.deepEqual(await uncommittedPaths(worktreeOf(harness)), []);
    harness.command({ kind: 'accept' });
    assert.equal(await driver, 0);
  } finally {
    if (!harness.state().finished) harness.command({ kind: 'abandon' });
    await driver;
  }
});

test('tests the polisher adapts are named to its reviewer, and discard it when there is no reviewer', async () => {
  // Not the file the check runs: that one is check configuration, which the polisher may never change.
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
      polish: async context => {
        const worktree = worktreeOf(h);
        write(worktree, 'greet.js', plainGreet);
        write(worktree, testFile, `// adapted\n${readText(`${worktree}/${testFile}`)}`);
        await commitAll(worktree, 'Polish greet and adapt its test');
        writeFileSync(outputPath(context.spec), polishReportJson(['greet.js', testFile]));
        return { outcome: 'succeeded' };
      },
    });

  const reviewed = await createHarness(workers, recipe);
  let driver = reviewed.run();
  let ready = await approveAndWait(reviewed, 'ready:0');
  assert.equal(ready.polish.get(0)?.decided?.kept, true, ready.polish.get(0)?.decided?.reasons.join('; '));
  const review = reviewed.orca.starts.find(start => start.title.startsWith('Polish review 0'));
  assert.match(review?.spec ?? '', /Tests the polish modified[\s\S]*test\/format\.test\.js/);
  reviewed.command({ kind: 'accept' });
  await driver;

  const unreviewed = await createHarness(workers, { ...recipe, name: 'polish-unreviewed', review: null });
  driver = unreviewed.run();
  ready = await approveAndWait(unreviewed, 'ready:0');
  const decided = ready.polish.get(0)?.decided;
  assert.equal(decided?.kept, false);
  assert.match(
    decided.reasons.join(),
    /tests changed with no review to confirm they were only adapted: test\/format\.test\.js/,
  );
  assert.equal(await headSha(worktreeOf(unreviewed)), decided.fromSha);
  unreviewed.command({ kind: 'accept' });
  await driver;
});

test('a round after a kept polish starts from the polished commit and is polished again', async () => {
  const harness = await createHarness(h => goodWorkers(h, { polish: polisher(h) }), recipe);
  const driver = harness.run();
  const first = await approveAndWait(harness, 'ready:0');
  const polished = first.polish.get(0)?.decided;
  assert.equal(polished?.kept, true);
  harness.command({ kind: 'continue', guidance: 'Add a comment.' });
  const second = await harness.until(state => state.attention?.reason === 'ready:1', 'ready after continue');
  assert.equal(second.guard.get(1)?.fromSha, polished.sha);
  assert.ok(second.polish.get(1)?.decided, 'every ready round gets a polish pass');
  harness.command({ kind: 'accept' });
  await driver;
});

test('a recipe without polish runs no polish stage', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:0');
  assert.equal(ready.polish.size, 0);
  assert.ok(!harness.orca.starts.some(start => start.title.startsWith('Polish')));
  harness.command({ kind: 'accept' });
  await driver;
});

test('resuming after discarded polish preserves subsequent round commits', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: polisher(h, { 'greet.js': 'export const greet = () => "wrong";\n' }),
      }),
    recipe,
  );
  const first = harness.run();
  await approveAndWait(harness, 'ready:0');
  harness.command({ kind: 'continue', guidance: 'Add a comment.' });
  const ready = await harness.until(state => state.attention?.reason === 'ready:1', 'second round');
  const sha = ready.verify.get(1)?.sha;
  assert.ok(sha);
  assert.notEqual(sha, ready.verify.get(0)?.sha);
  harness.orca.failNextCheck = true;
  assert.equal(await first, 1);
  harness.command({ kind: 'accept' });
  assert.equal(await harness.run(), 0);
  assert.equal(harness.state().finished?.sha, sha);
  assert.equal(await headSha(worktreeOf(harness)), sha);
});

test('a driver that dies during the polish review resumes without polishing or checking again', async () => {
  let release = () => {};
  const reviewed = new Promise<void>(resolve => (release = resolve));
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: polisher(h),
        'polish-review': async context => {
          await reviewed;
          writeFileSync(outputPath(context.spec), polishReviewJson());
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const first = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1), 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(state => state.stages.has('polish-review:0'), 'the polish review');
  harness.orca.failNextCheck = true;
  assert.equal(await first, 1);

  release();
  const second = harness.run();
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready after resuming');
  assert.equal(ready.polish.get(0)?.decided?.kept, true);
  const titles = harness.orca.starts.map(start => start.title);
  assert.equal(titles.filter(title => title.startsWith('Polish 0')).length, 1);
  assert.equal(titles.filter(title => title.startsWith('Polish review 0')).length, 1);
  const checked = harness.store.events().filter(event => event.type === 'polish.checked');
  assert.equal(checked.length, 1, 'the checks of the polished commit ran once');
  harness.command({ kind: 'accept' });
  assert.equal(await second, 0);
});

test('behaviour-preserving polish without a maintenance benefit is discarded', async () => {
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        polish: polisher(h),
        'polish-review': context => {
          writeFileSync(outputPath(context.spec), polishReviewJson('no-benefit'));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  try {
    const ready = await approveAndWait(harness, 'ready:0');
    assert.equal(ready.polish.get(0)?.decided?.outcome, 'discarded');
    assert.match(ready.polish.get(0)?.decided?.reasons.join() ?? '', /no-benefit/);
    assert.equal(await headSha(worktreeOf(harness)), ready.verify.get(0)?.sha);
  } finally {
    harness.command({ kind: 'abandon' });
    await driver;
  }
});
