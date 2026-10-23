// Candidate evidence must describe one commit and spec, even across repairs and restarts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { finalCandidate } from '../src/pipeline/candidate.js';
import {
  createHarness,
  goodWorkers,
  outputPath,
  reviewJson,
  commitAll,
  worktreeOf,
  write,
} from './helpers/task-fixture.js';

test('candidate resolution refuses mixed commits and never relabels evidence with a newer spec', async () => {
  const h = await createHarness(h => goodWorkers(h));
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => s.attention?.reason === 'ready:0', 'ready');
    assert.ok(finalCandidate(state));
    const review = state.reviews.get(0)!;
    state.reviews.set(0, { ...review, sha: state.workspace!.baseSha });
    assert.equal(finalCandidate(state), null, 'review of another commit cannot authorise this candidate');
    state.reviews.set(0, review);
    const guard = state.guard.get(0)!;
    state.guard.set(0, { ...guard, sha: state.workspace!.baseSha });
    assert.equal(finalCandidate(state), null, 'guard of another commit cannot authorise this candidate');
    state.guard.set(0, guard);
    const decision = state.decisions.get(0)!;
    state.decisions.set(0, { ...decision, specVersion: 2 });
    assert.equal(finalCandidate(state), null, 'readiness belongs to the same evidence');
    state.decisions.set(0, decision);
    const checked = state.verify.get(0)!;
    state.verify.set(0, { ...checked, results: [] });
    assert.equal(finalCandidate(state), null, 'missing checks cannot count as complete evidence');
    state.verify.set(0, checked);
    state.specs.push({ ...state.specs[0]!, version: 2, hash: 'revised' });
    assert.equal(finalCandidate(state), null, 'old checks cannot inherit a newer spec version');
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('an unknown review escalates instead of declaring the candidate ready', async () => {
  const h = await createHarness(h =>
    goodWorkers(h, {
      review: context => {
        writeFileSync(outputPath(context.spec), reviewJson('unknown'));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => s.decisions.has(0), 'decision');
    assert.equal(state.decisions.get(0)?.decision, 'escalate');
    assert.match(state.decisions.get(0)?.reasons.join() ?? '', /unknown/);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('a reviewer moving HEAD cannot leave an approving review attached to the old checks', async () => {
  const h = await createHarness(h =>
    goodWorkers(h, {
      review: async context => {
        write(worktreeOf(h), 'greet.js', 'export const greet = () => "broken";\n');
        await commitAll(worktreeOf(h), 'Unexpected reviewer edit');
        writeFileSync(outputPath(context.spec), reviewJson('approve'));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
    h.command({ kind: 'approve', specVersion: 1 });
    const state = await h.until(s => Boolean(s.lastStop) || s.decisions.has(0), 'review result');
    assert.ok(state.lastStop, 'unexpected mutations must stop verification');
    assert.equal(state.decisions.size, 0);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('restart during a continued repair replays the earlier decision without requiring its obsolete candidate', async () => {
  let release = () => {};
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await createHarness(h =>
    goodWorkers(h, {
      repair: async context => {
        await pending;
        return goodWorkers(h)(context);
      },
    }),
  );
  const first = h.run();
  await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
  h.command({ kind: 'approve', specVersion: 1 });
  await h.until(s => s.attention?.reason === 'ready:0', 'ready');
  h.command({ kind: 'continue', guidance: 'Add a comment.' });
  await h.until(s => Boolean(s.stages.get('repair:1')?.dispatches.length), 'repair running');
  h.orca.failNextCheck = true;
  assert.equal(await first, 1);
  const resumed = h.run();
  try {
    release();
    const state = await h.until(s => s.attention?.reason === 'ready:1' || Boolean(s.lastStop), 'resumed result');
    // Ignore the previous driver's stop until the resumed driver has recorded its start.
    const current = state.lastStop
      ? await h.until(
          s =>
            s.attention?.reason === 'ready:1' || h.store.events().filter(e => e.type === 'driver.stopped').length > 1,
          'new result',
        )
      : state;
    assert.equal(current.attention?.reason, 'ready:1');
    assert.equal(h.orca.starts.filter(start => start.title.startsWith('Repair 1')).length, 1);
  } finally {
    release();
    h.command({ kind: 'abandon' });
    await resumed;
  }
});
