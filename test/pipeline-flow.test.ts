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
  reviewJson,
  roleOf,
  specText,
  worktreeOf,
  write,
} from './helpers/task-fixture.js';

test('a task runs spec, approval, baseline, build, verify and review to acceptance', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();

  // The spec review runs alongside the approval request; wait for it so the review line is present.
  const awaiting = await harness.until(
    state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1),
    'spec approval with its review',
  );
  assert.equal(awaiting.specs.length, 1);
  assert.equal(awaiting.specReviews.get(1)?.report?.verdict, 'approve');
  assert.ok(awaiting.gate, 'the approval gate exists in Orca');
  // Whoever relays the approval (a chat agent or the terminal) must be able to show the spec itself.
  const shown = renderSummary(summarise(awaiting));
  assert.match(shown, /greet\('Ada'\) returns 'Hello, Ada!'/, 'the spec text is part of the approval request');
  assert.match(shown, /spec review: approve/);
  harness.command({ kind: 'approve', specVersion: 1 });

  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready to accept');
  // The accept request carries the evidence, so it can be shown before anyone is asked to decide.
  const result = renderSummary(summarise(ready));
  assert.match(result, /----- round 0 result/);
  assert.match(result, /1 commit; changed: greet\.js/);
  assert.match(result, /check greet: passed/);
  assert.match(result, /review: approve\. Reviewed\./);
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
  // A finished driver closes its tab, so the shell no longer holds the worktree open; a stopped one
  // (non-zero exit) keeps it so the user can read why and rerun it.
  assert.deepEqual(harness.orca.terminals, [`drive ${harness.taskId}`]);
  assert.ok(harness.orca.closed.includes(harness.orca.firstTerminal), "Orca's automatic first tab was closed");
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

test('check configuration changed in any round is named for the reviewer and the user', async () => {
  const reviewPrompts: string[] = [];
  const harness = await createHarness(h =>
    goodWorkers(h, {
      build: async () => {
        const worktree = worktreeOf(h);
        write(worktree, 'Directory.Build.props', '<Project />\n');
        await commitAll(worktree, 'Ignore an exit code but do not greet yet');
        return { outcome: 'succeeded' };
      },
      review: context => {
        reviewPrompts.push(context.spec);
        writeFileSync(outputPath(context.spec), reviewJson('approve'));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(state => state.attention?.reason === 'ready:1', 'ready after a repair');
  assert.deepEqual(ready.guard.get(0)?.guard.modifiedCheckConfig, ['Directory.Build.props']);
  assert.deepEqual(ready.guard.get(1)?.guard.modifiedCheckConfig, []);
  assert.equal(reviewPrompts.length, 2);
  for (const prompt of reviewPrompts) assert.match(prompt, /configure how the checks run[^]*Directory\.Build\.props/);
  assert.match(
    ready.attention?.detail ?? '',
    /check configuration changed since the build started: Directory\.Build\.props/,
  );
  harness.command({ kind: 'abandon' });
  await driver;
});

test('the spec reaches the user before its review, and approving early stops the reviewer', async () => {
  const harness = await createHarness(h => goodWorkers(h, { 'spec-review': () => 'hang' }));
  const driver = harness.run();
  const awaiting = await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  assert.equal(awaiting.specReviews.has(1), false, 'the review is still running');
  assert.match(renderSummary(summarise(awaiting)), /spec review: still running/);
  harness.command({ kind: 'approve', specVersion: 1 });
  const building = await harness.until(state => state.stages.has('build:0'), 'build after early approval');
  const reviewer = building.stages.get('spec-review:1')?.dispatches[0];
  assert.ok(reviewer && harness.orca.stopped.includes(reviewer.dispatchId), 'the unfinished reviewer was stopped');
  assert.match(building.specReviews.get(1)?.error ?? '', /stopped: the user decided before the review finished/);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a blocking spec review finding that arrives after the request notifies the user again', async () => {
  let release = () => {};
  const reviewDone = new Promise<void>(resolve => (release = resolve));
  const harness = await createHarness(h =>
    goodWorkers(h, {
      'spec-review': async context => {
        await reviewDone;
        const finding = { severity: 'blocking', title: 'Greeting for an empty name is undefined' };
        writeFileSync(
          outputPath(context.spec),
          JSON.stringify({ verdict: 'changes', summary: 'Gap.', findings: [finding] }),
        );
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'first request');
  release();
  const renotified = await harness.until(state => state.specReviews.has(1), 'review recorded');
  const requests = harness.store
    .events()
    .filter(event => event.type === 'attention.needed' && event.reason === 'approve-spec:1');
  assert.equal(requests.length, 2, 'a second request carries the blocking finding');
  assert.match(renotified.attention?.detail ?? '', /1 blocking/);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a clean spec review that lands after the request notifies the user and updates the request', async () => {
  let release = () => {};
  const reviewDone = new Promise<void>(resolve => (release = resolve));
  const harness = await createHarness(h =>
    goodWorkers(h, {
      'spec-review': async context => {
        await reviewDone;
        writeFileSync(outputPath(context.spec), JSON.stringify({ verdict: 'approve', summary: 'Fine.', findings: [] }));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const first = await harness.until(state => state.attention?.reason === 'approve-spec:1', 'first request');
  assert.match(first.attention?.detail ?? '', /still running/);
  release();
  // `grampus wait` wakes on a newer request: someone waiting for the review must hear that it landed.
  const updated = await harness.until(
    state => state.specReviews.has(1) && !/still running/.test(state.attention?.detail ?? ''),
    'request updated with the review',
  );
  assert.ok((updated.attention?.since ?? '') > (first.attention?.since ?? ''), 'a newer request wakes waiters');
  assert.match(updated.attention?.detail ?? '', /spec review: approve, 0 blocking/);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a driver that finishes cleanly closes its own Orca tab; one that stops keeps it', async () => {
  const previous = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_driver';
  try {
    const harness = await createHarness(h => goodWorkers(h));
    harness.orca.failNextStarts = 1;
    assert.equal(await harness.run(), 1);
    assert.equal(harness.orca.closed.includes('term_driver'), false, 'a stopped driver keeps its tab for a rerun');
    const driver = harness.run();
    await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
    harness.command({ kind: 'abandon' });
    assert.equal(await driver, 0);
    assert.ok(harness.orca.closed.includes('term_driver'), 'a finished driver closes its tab, releasing the worktree');
  } finally {
    if (previous === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previous;
  }
});
