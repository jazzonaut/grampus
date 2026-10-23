// Change explanation workers run against real commits, keep evidence and never change the verdict.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentSettings } from '../src/config/settings.js';
import { standardRecipe } from '../src/domain/recipe.js';
import { explanationSchema } from '../src/domain/explanation.js';
import { headSha } from '../src/git/git.js';
import { driveReview } from '../src/pipeline/driver.js';
import { TaskStore } from '../src/store/task-store.js';
import { commitAll, createHarness, goodWorkers, worktreeOf, type Harness } from './helpers/task-fixture.js';

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

test('purpose groups have unique identities', () => {
  assert.throws(
    () => explanationSchema.parse({ ...explanation, groups: [...explanation.groups, ...explanation.groups] }),
    /unique/,
  );
});

for (const failure of ['empty-reference', 'store-evidence'] as const) {
  test(`an explanation with ${failure} is unavailable rather than usable evidence`, async () => {
    const harness = await createHarness(h => async context => {
      if (context.title.startsWith('Build:')) {
        const result = await workers(h)(context);
        writeFileSync(join(worktreeOf(h), 'empty.txt'), '');
        await commitAll(worktreeOf(h), 'Add an empty file');
        return result;
      }
      if (context.title.startsWith('Explain:')) {
        const report =
          failure === 'empty-reference'
            ? {
                ...explanation,
                groups: [{ ...explanation.groups[0], references: [{ path: 'empty.txt', start: 1, end: 1 }] }],
              }
            : explanation;
        writeFileSync(reportPath(context.spec), JSON.stringify(report));
        if (failure === 'store-evidence') {
          const command = h.store.commands().find(command => command.kind === 'explain');
          assert.ok(command);
          mkdirSync(join(h.store.dir, 'explanations', `${command.id}.json`), { recursive: true });
        }
        return { outcome: 'succeeded' };
      }
      return workers(h)(context);
    });
    const driver = harness.run();
    await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
    harness.command({ kind: 'approve', specVersion: 1 });
    const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
    const candidateSha = await headSha(worktreeOf(harness));
    harness.command({ kind: 'explain', baseSha: ready.workspace?.baseSha, candidateSha, specVersion: 1 });
    const reviewed = await harness.until(state => state.explanations.size > 0, 'explanation outcome');
    harness.command({ kind: 'accept' });
    assert.equal(await driver, 0);
    assert.equal(reviewed.explanations.get(candidateSha)?.explanation, null);
    assert.ok(reviewed.explanations.get(candidateSha)?.error);
  });
}

test('pre-existing uncommitted work makes automatic explanation unavailable without blocking repair', async t => {
  const harness = await createHarness(
    h => async context => {
      if (context.title.startsWith('Build:')) {
        writeFileSync(join(worktreeOf(h), 'greet.js'), 'export function greet() { return "wrong"; }\n');
        return { outcome: 'failed', body: 'The implementation is unfinished.' };
      }
      return workers(h)(context);
    },
    {
      ...standardRecipe,
      name: 'dirty-explanation',
      repair: { ...standardRecipe.repair, maxRounds: 0 },
      explain: { automatic: true, assignment: { agent: 'claude' } },
    },
  );
  const driver = harness.run();
  t.after(async () => {
    if (!harness.state().finished) harness.command({ kind: 'abandon' });
    await driver;
  });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const state = await harness.until(state => !!state.lastStop || state.explanations.size > 0, 'explanation outcome');
  assert.equal(state.lastStop, null);
  assert.match([...state.explanations.values()][0]?.error ?? '', /uncommitted/);
  assert.equal(
    harness.orca.starts.some(start => start.title.startsWith('Explain:')),
    false,
  );
  harness.command({ kind: 'continue', guidance: 'Finish and commit the greeting.' });
  await harness.until(
    state => state.attention?.reason === 'ready:1' && state.explanations.size === 2,
    'repaired explanation',
  );
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
});

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
    state => state.attention?.reason === 'ready:0' && state.explanations.size > 0,
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
    state => state.attention?.reason === 'ready:0' && state.explanations.size > 0,
    'acceptance after invalid reference',
  );
  assert.match([...ready.explanations.values()][0]?.error ?? '', /outside the candidate/);
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
});

test('queued explanations finish in order instead of recursively starting workers', async () => {
  let started = 0;
  const harness = await createHarness(h => async context => {
    if (context.title.startsWith('Explain:')) {
      started++;
      if (started === 2 && !h.state().explanations.size)
        return { outcome: 'failed', body: 'The previous explanation has not been recorded.' };
    }
    return workers(h)(context);
  });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  const binding = {
    baseSha: ready.workspace?.baseSha,
    candidateSha: await headSha(worktreeOf(harness)),
    specVersion: 1,
  };
  harness.command({ kind: 'explain', ...binding });
  harness.command({ kind: 'explain', ...binding });
  await harness.until(
    () => harness.store.events().filter(event => event.type === 'explanation.recorded').length === 2,
    'both explanations',
  );
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  const results = harness.store.events().filter(event => event.type === 'explanation.recorded');
  assert.deepEqual(
    results.map(event => event.error),
    [null, null],
  );
});

test('an explanation that commits code stops acceptance and remains unsafe on restart', async () => {
  const harness = await createHarness(h => async context => {
    if (context.title.startsWith('Explain:')) {
      writeFileSync(join(worktreeOf(h), 'greet.js'), 'export function greet() { return "wrong"; }\n');
      await commitAll(worktreeOf(h), 'Unexpected explanation edit');
      // Failure must not bypass the integrity check either.
      return { outcome: 'failed', body: 'Could not explain' };
    }
    return workers(h)(context);
  });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  harness.command({
    kind: 'explain',
    baseSha: ready.workspace?.baseSha,
    candidateSha: await headSha(worktreeOf(harness)),
    specVersion: 1,
  });
  await harness.until(state => !!state.lastStop || state.explanations.size > 0, 'review outcome');
  // Queue acceptance only after the worker has ended, as the dashboard permits.
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 1, 'changed code must not inherit the earlier verification');
  assert.equal(harness.state().finished, null);
  assert.equal(await harness.run(), 1, 'restart must still reject the changed candidate');
});

test('a completed task can answer a question from its follow-up worker', async () => {
  const harness = await createHarness(
    h => async context => {
      if (context.title.startsWith('Answer:')) await context.ask('Which part should I explain?');
      return workers(h)(context);
    },
    { ...standardRecipe, name: 'explain-reply', explain: { automatic: true, assignment: { agent: 'claude' } } },
  );
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(
    state => state.attention?.reason === 'ready:0' && state.explanations.size > 0,
    'ready',
  );
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  harness.command({
    kind: 'ask',
    baseSha: ready.workspace?.baseSha,
    candidateSha: await headSha(worktreeOf(harness)),
    specVersion: 1,
    question: 'Why?',
    groupId: null,
    reference: null,
  });
  const review = driveReview(TaskStore.open(harness.dataDir, harness.taskId), harness.orca, () => undefined);
  const asked = await harness.until(
    state => [...state.questions.values()].some(question => !question.closed && !question.answered),
    'worker question',
  );
  const messageId = [...asked.questions.entries()].find(([, question]) => !question.closed && !question.answered)?.[0];
  harness.command({ kind: 'reply', messageId, body: 'The name argument.' });
  await harness.until(
    state => state.refusals.some(refusal => refusal.kind === 'reply') || harness.orca.replies.size > 0,
    'reply outcome',
  );
  assert.equal(harness.orca.replies.get(messageId ?? ''), 'The name argument.');
  assert.equal(await review, 0);
  assert.equal(harness.state().answers[0]?.error, null);
});

test('an automatic explanation leaves acceptance available while its worker is running', async t => {
  const harness = await createHarness(
    h => context => (context.title.startsWith('Explain:') ? 'hang' : workers(h)(context)),
    { ...standardRecipe, name: 'explain-hang', explain: { automatic: true, assignment: { agent: 'claude' } } },
  );
  const driver = harness.run();
  t.after(async () => {
    if (!harness.state().finished) harness.command({ kind: 'abandon' });
    await driver;
  });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const explaining = await harness.until(
    state => [...state.stages.values()].some(stage => stage.stage === 'explain' && stage.dispatches.length > 0),
    'explaining',
  );
  assert.equal(explaining.attention?.reason, 'ready:0');
  harness.command({ kind: 'accept' });
  await harness.until(state => !!state.finished, 'acceptance while explaining');
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.outcome, 'accepted');
  assert.equal(harness.orca.stopped.length, 1, 'the optional worker is stopped before acceptance');
});

test('an interrupted completed-task review records a stop and resumes its existing dispatch', async () => {
  const harness = await createHarness(h => workers(h));
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  const ready = await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  harness.command({
    kind: 'explain',
    baseSha: ready.workspace?.baseSha,
    candidateSha: await headSha(worktreeOf(harness)),
    specVersion: 1,
  });
  harness.orca.uncertainChecks = currentSettings().orcaRetries + 1;
  const review = () => driveReview(TaskStore.open(harness.dataDir, harness.taskId), harness.orca, () => undefined);
  assert.equal(await review(), 1);
  assert.ok(harness.state().lastStop);
  assert.equal(await review(), 0);
  assert.equal(harness.orca.starts.filter(start => start.title.startsWith('Explain:')).length, 1);
});
