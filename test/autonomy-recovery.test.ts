// Compound failures exercise bounded recovery across restarts without manufacturing human decisions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { recipeSchema } from '../src/domain/recipe.js';
import { DriverCore } from '../src/pipeline/driver-core.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { createHarness, goodWorkers, outputPath, reviewJson, specText } from './helpers/task-fixture.js';

test('technical revisions, malformed reports, a stalled builder and restart recover without commands', async () => {
  let specs = 0;
  let reviews = 0;
  let builds = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        spec: context => {
          writeFileSync(
            outputPath(context.spec),
            ++specs < 3 ? specText([{ name: 'missing', command: 'node missing.js' }]) : specText(),
          );
          return { outcome: 'succeeded' };
        },
        build: context => (++builds === 1 ? 'hang' : goodWorkers(h)(context)),
        review: context => {
          if (++reviews === 1) {
            writeFileSync(
              outputPath(context.spec),
              reviewJson('approve').replace('"findings":[]', '"findings":[],"unexpected":true'),
            );
          } else {
            assert.match(context.spec, /Do not repeat the investigation/);
            const previous = /existing report at (.+?); specification/.exec(context.spec)?.[1];
            assert.ok(previous);
            assert.match(readFileSync(previous, 'utf8'), /unexpected/);
            writeFileSync(outputPath(context.spec), reviewJson('approve'));
          }
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', stageSeconds: 5, specRevisions: 3 } }),
  );
  let driver = h.run();
  try {
    await h.until(s => s.stages.get('build:0')?.attempts === 1, 'first builder');
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1);
    driver = h.run();
    const state = await h.until(s => s.finished !== null, 'resumed autonomous delivery');
    assert.equal(state.finished?.outcome, 'accepted');
    assert.equal(state.commands.length, 0);
    assert.equal(builds, 2);
    assert.equal(specs, 3);
    assert.equal(reviews, 2);
    assert.equal(h.orca.stopped.length, 1);
    assert.equal(state.verify.get(0)?.sha, state.reviews.get(0)?.sha);
    assert.equal(state.reviews.get(0)?.specVersion, 3);
    assert.equal(
      state.verify.get(0)?.results.every(result => result.passed),
      true,
    );
    assert.equal(state.stages.get('build:0')?.dispatches[0]?.stopped, true);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('an acknowledged stop with unknown liveness never launches a replacement, including after restart', async () => {
  const h = await createHarness(
    () => () => 'hang',
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', stageSeconds: 1, maxSeconds: 60 } }),
  );
  // Model Orca acknowledging stop before its worker has actually exited.
  h.orca.stopWorker = async id => {
    h.orca.stopped.push(id);
    h.orca.liveness.set(id, 'unknown');
  };
  let driver = h.run();
  try {
    await h.until(s => s.policyDecisions.has('stop-stalled:spec:1:1'), 'stop intent');
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1);
    driver = h.run();
    await h.until(s => s.lastStop === null, 'resumed stop confirmation');
    assert.equal(h.orca.starts.length, 1);
    assert.equal(h.state().stages.get('spec:1')?.dispatches[0]?.stopped, false);
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1);
    assert.equal(h.orca.starts.length, 1);
    assert.equal(h.state().commands.length, 0);
    assert.equal(h.state().finished, null);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('product ambiguity is escalated without spending the technical revision allowance', async () => {
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        'spec-review': context => {
          writeFileSync(
            outputPath(context.spec),
            reviewJson('changes', [
              {
                severity: 'blocking',
                resolution: 'product',
                title: 'Choose retention policy',
                detail: 'The request and repository do not choose a retention period.',
              },
            ]),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } }),
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.attention !== null, 'product decision');
    assert.equal(state.attention?.reason, 'spec-product:1');
    assert.equal(state.specs.length, 1);
    assert.equal(state.policyDecisions.has('revise-spec:1'), false);
    assert.equal(state.commands.length, 0);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('technical revision allowance does not reset after restart', async () => {
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        'spec-review': context => {
          writeFileSync(outputPath(context.spec), reviewJson('changes'));
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', specRevisions: 2 } }),
  );
  let driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'spec-recovery:3', 'revision limit');
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1);
    driver = h.run();
    await h.until(s => s.lastStop === null, 'restart');
    assert.equal(h.state().specs.length, 3);
    assert.equal(new DriverCore(h.store, h.orca, () => {}).state.policyDecisions.size, 2);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('an optional question resolver also has a bounded deadline and automatic replacement', async () => {
  let resolvers = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        build: async context => {
          assert.match(await context.ask('Where is greet implemented?'), /greet.js/);
          return goodWorkers(h)(context);
        },
        question: context => {
          if (++resolvers === 1) return 'hang';
          writeFileSync(
            outputPath(context.spec),
            JSON.stringify({ disposition: 'answer', body: 'Use greet.js.', references: ['greet.js'] }),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', stageSeconds: 3 } }),
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.finished !== null, 'resolver recovery');
    assert.equal(state.finished?.outcome, 'accepted');
    assert.equal(state.commands.length, 0);
    assert.equal(resolvers, 2);
    assert.equal(h.orca.stopped.length, 1);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});
