// Change explanation workers run against real commits, keep evidence and never change the verdict.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import { headSha } from '../src/git/git.js';
import { driveReview } from '../src/pipeline/driver.js';
import { TaskStore } from '../src/store/task-store.js';
import { createHarness, goodWorkers, type Harness } from './helpers/task-fixture.js';

const explanation = {
  problem: 'The greeting omitted the name.',
  beforeAfter: 'Before it returned Hi; now it returns Hello, Ada!',
  architecture: 'greet.js exports the greeting function.',
  approach: 'The implementation uses the name argument.',
  decisions: 'The approved spec requires the name in the result.',
  validation: 'The greet check passed at the candidate.',
  limitations: 'Only the recorded greet case is checked.',
  groups: [
    {
      id: 'greeting',
      title: 'Greet by name',
      purpose: 'Use the supplied name.',
      references: [{ path: 'greet.js', start: 2, end: 3 }],
    },
  ],
};

function workers(harness: Harness, fail = false, badReference = false) {
  const normal = goodWorkers(harness);
  return async (context: Parameters<typeof normal>[0]) => {
    if (context.title.startsWith('Explain:')) {
      if (fail) return { outcome: 'failed' as const, body: 'could not explain' };
      writeFileSync(
        reportPath(context.spec),
        JSON.stringify(
          badReference
            ? {
                ...explanation,
                groups: [{ ...explanation.groups[0], references: [{ path: 'greet.js', start: 999, end: 999 }] }],
              }
            : explanation,
        ),
      );
      return { outcome: 'succeeded' as const };
    }
    if (context.title.startsWith('Answer:')) {
      writeFileSync(
        reportPath(context.spec),
        JSON.stringify({ answer: 'The spec names Ada.', references: [{ path: 'greet.js', start: 2, end: 2 }] }),
      );
      return { outcome: 'succeeded' as const };
    }
    return normal(context);
  };
}

function reportPath(prompt: string): string {
  const match = /Write JSON to (\S+report\.json)/.exec(prompt);
  if (!match?.[1]) throw new Error(`Missing report path in ${prompt}`);
  return match[1];
}

test('automatic explanation, follow-up and later access share candidate-bound evidence', async () => {
  const harness = await createHarness(h => workers(h), {
    ...standardRecipe,
    name: 'explained',
    explain: { automatic: true, assignment: { agent: 'claude' } },
  });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(
    state => state.attention?.reason === 'ready:0' && state.explanations.size > 0,
    'explained candidate',
  );
  const candidateSha = await headSha(ready.workspace?.path ?? '');
  assert.equal(ready.explanations.get(candidateSha)?.explanation?.groups[0]?.id, 'greeting');
  const binding = { baseSha: ready.workspace?.baseSha, candidateSha, specVersion: 1 };
  harness.command({
    kind: 'ask',
    ...binding,
    question: 'Why the name?',
    groupId: 'greeting',
    reference: { path: 'greet.js', start: 2, end: 2 },
  });
  await harness.until(state => state.answers.length === 1, 'follow-up answer');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.outcome, 'accepted');
  assert.equal(
    harness.state().measurements?.some(item => item.stage === 'explain'),
    true,
  );

  harness.command({ kind: 'ask', ...binding, question: 'What was checked?', groupId: null, reference: null });
  assert.equal(await driveReview(TaskStore.open(harness.dataDir, harness.taskId), harness.orca, () => undefined), 0);
  assert.equal(harness.state().answers.length, 2);
  assert.equal(harness.state().answers[1]?.answer?.answer, 'The spec names Ada.');
  assert.equal(harness.orca.released.length, harness.orca.starts.length, 'later workers are released too');
});

test('an unavailable explanation leaves acceptance available', async () => {
  const harness = await createHarness(h => workers(h, true), {
    ...standardRecipe,
    name: 'explain-failure',
    explain: { automatic: true, assignment: { agent: 'claude' } },
  });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(
    state => state.attention?.reason === 'ready:0',
    'acceptance after explanation failure',
  );
  assert.equal([...ready.explanations.values()][0]?.error?.includes('could not explain'), true);
  assert.equal(ready.decisions.get(0)?.decision, 'ready');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
});

test('a fabricated code reference is refused as explanation evidence', async () => {
  const harness = await createHarness(h => workers(h, false, true), {
    ...standardRecipe,
    name: 'bad-reference',
    explain: { automatic: true, assignment: { agent: 'claude' } },
  });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(
    state => state.attention?.reason === 'ready:0',
    'acceptance after invalid reference',
  );
  assert.match([...ready.explanations.values()][0]?.error ?? '', /outside the candidate/);
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
});
