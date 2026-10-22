import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderSummary, summarise } from '../src/pipeline/status.js';
import { createHarness, goodWorkers, outputPath, reviewJson, specText } from './helpers/task-fixture.js';

test('the checks run on the original commit before approval, reach the spec reviewer and become the baseline', async () => {
  let reviewPrompt = '';
  const harness = await createHarness(h =>
    goodWorkers(h, {
      'spec-review': context => {
        reviewPrompt = context.spec;
        writeFileSync(outputPath(context.spec), reviewJson('approve'));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const awaiting = await harness.until(
    state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1),
    'approval with checks and review',
  );
  const checked = awaiting.specChecks.get(1);
  assert.equal(checked?.sha, awaiting.workspace?.baseSha, 'the checks ran on the base commit');
  assert.equal(checked?.results[0]?.passed, false);
  assert.match(reviewPrompt, /greet: FAILED \(exit 1\)\. Log tail:\n[^]*greet failed: Hi/);
  assert.match(awaiting.attention?.detail ?? '', /failing: "greet" \(exit 1\)/);
  const shown = renderSummary(summarise(awaiting));
  assert.match(shown, /checks on the original commit[^\n]*\n {2}check greet: FAILED[^\n]*\n {4}\| greet failed: Hi/);

  harness.command({ kind: 'approve', specVersion: 1 });
  const building = await harness.until(state => state.stages.has('build:0'), 'build');
  assert.deepEqual(building.baseline, checked, 'the baseline is the run the user saw, not a second run');
  harness.command({ kind: 'abandon' });
  await driver;
});

test('approving before the checks finish waits for them before the build', async () => {
  const slow = { name: 'slow', command: 'node -e "setTimeout(() => process.exit(1), 1500)"' };
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        writeFileSync(outputPath(context.spec), specText([slow]));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const awaiting = await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  assert.deepEqual(summarise(awaiting).approval?.running, ['checks', 'spec review']);
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(
    state => summarise(state).phase === 'running the checks before the build',
    'the status says what the driver is doing',
  );
  const building = await harness.until(state => state.stages.has('build:0'), 'build');
  assert.ok(building.specChecks.has(1));
  assert.deepEqual(building.baseline, building.specChecks.get(1));
  assert.match(building.specReviews.get(1)?.error ?? '', /not started: the user decided before the checks/);
  const events = harness.store.events();
  const checksAt = events.findIndex(event => event.type === 'checks.recorded' && event.phase === 'spec');
  const buildAt = events.findIndex(event => event.type === 'stage.created' && event.key === 'build:0');
  assert.ok(checksAt >= 0 && checksAt < buildAt, 'the build starts after the checks finished');
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a revision stops the checks of the version it replaces', async () => {
  const hanging = {
    name: 'hanging',
    command: 'node -e "setTimeout(() => {}, 30000)"',
    timeoutSeconds: 60,
  };
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        writeFileSync(
          outputPath(context.spec),
          context.title.startsWith('Spec revision') ? specText() : specText([hanging]),
        );
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'first approval');
  const revisedAt = Date.now();
  harness.command({ kind: 'revise', feedback: 'Use the greet test.' });
  const second = await harness.until(
    state => state.attention?.reason === 'approve-spec:2' && state.specChecks.has(2),
    'second approval with its checks',
  );
  assert.ok(Date.now() - revisedAt < 20_000, 'the hanging check was stopped, not waited for');
  assert.equal(second.specChecks.has(1), false, 'stopped checks are not evidence');
  harness.command({ kind: 'abandon' });
  await driver;
});
