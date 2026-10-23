// Automatic coverage repairs remain bounded across verification, user continuation and driver restarts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { coverageRecipe, gapReport } from './helpers/coverage-fixture.js';
import { createHarness, goodWorkers, outputPath, reviewJson } from './helpers/task-fixture.js';
test('actionable coverage gaps repair automatically with the original request and full coverage evidence', async () => {
  let reviews = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          writeFileSync(
            outputPath(context.spec),
            reviews++ === 0 ? JSON.stringify(gapReport()) : reviewJson('approve'),
          );
          return { outcome: 'succeeded' };
        },
        repair: async context => {
          assert.ok(context.spec.includes(h.state().request));
          assert.match(context.spec, /The original request includes an empty-name fallback/);
          assert.match(context.spec, /Only the named greeting was exercised/);
          assert.match(context.spec, /Add a real empty-name journey/);
          assert.match(context.spec, /Handle an empty name/);
          return goodWorkers(h)(context);
        },
      }),
    coverageRecipe(3),
  );
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => s.decisions.has(0), 'round decision');
    assert.equal(state.decisions.get(0)?.decision, 'repair');
    await h.until(s => s.attention?.reason === 'ready:1', 'verified repair');
    assert.equal(h.state().commands.filter(c => c.kind === 'continue').length, 0);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('coverage allowance survives a restart and manual continuation does not replenish it', async () => {
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          writeFileSync(outputPath(context.spec), JSON.stringify(gapReport()));
          return { outcome: 'succeeded' };
        },
      }),
    coverageRecipe(3),
  );
  let driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => s.decisions.has(0), 'round decision');
    assert.equal(state.decisions.get(0)?.decision, 'repair');
    // Each round performs real Git operations; bound individual progress under parallel test load.
    await h.until(s => s.decisions.has(1), 'first coverage repair decision');
    await h.until(s => s.decisions.has(2), 'second coverage repair decision');
    await h.until(s => s.attention?.reason === 'escalate:3', 'coverage allowance exhausted');
    assert.equal(h.orca.starts.filter(start => start.title.startsWith('Repair')).length, 3);
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1, 'simulate a lost driver while awaiting the user');
    driver = h.run();
    await h.until(s => s.lastStop === null, 'resumed driver');
    h.command({ kind: 'continue', guidance: 'Try the fallback once more.' });
    await h.until(s => s.attention?.reason === 'escalate:4', 'manual round exhausted');
    assert.equal(h.orca.starts.filter(start => start.title.startsWith('Repair')).length, 4);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('ordinary and coverage repairs have independent allowances', async () => {
  let reviews = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          const report = gapReport();
          if (reviews++ % 2 === 0) {
            report.requestCoverage = { verdict: 'covered', rationale: 'All requested behaviour is accounted for.' };
            report.coverage = [
              {
                acceptanceId: 'greeting',
                status: 'verified',
                evidence: 'The real greeting check passed.',
                limitations: [],
              },
            ];
          }
          writeFileSync(outputPath(context.spec), JSON.stringify(report));
          return { outcome: 'succeeded' };
        },
      }),
    coverageRecipe(1, 1),
  );
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => s.attention?.reason === 'escalate:2', 'ordinary allowance exhausted');
    assert.equal(state.decisions.get(0)?.decision, 'repair');
    assert.equal(state.decisions.get(1)?.decision, 'repair');
    assert.match(state.decisions.get(2)?.reasons.join() ?? '', /ordinary repair allowance exhausted \(1\/1\)/);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});
