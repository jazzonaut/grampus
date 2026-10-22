import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHarness, goodWorkers, outputPath, specText } from './helpers/task-fixture.js';

test('a lost worker-start response stops the driver, and rerunning replays the same request', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  harness.orca.failNextStarts = 1;
  assert.equal(await harness.run(), 1, 'the driver stops instead of guessing');
  const stopped = harness.state();
  assert.match(stopped.lastStop?.reason ?? '', /worker-start response lost/);
  assert.equal(harness.orca.starts.length, 1, 'Orca did start the worker');

  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval after resuming');
  const starts = harness.orca.mutations.filter(mutation => mutation.name === 'worker-start');
  assert.deepEqual(
    starts.map(mutation => mutation.replayed),
    [false, true, false],
    'the spec start is replayed by request id, then the spec review starts once',
  );
  assert.equal(harness.orca.starts.length, 2, 'no duplicate spec writer');
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a driver that dies while waiting resumes at the same decision without new dispatches', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const first = harness.run();
  await harness.until(state => state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1), 'approval');
  harness.orca.failNextCheck = true;
  assert.equal(await first, 1);
  const startsBefore = harness.orca.starts.length;
  const requests = () =>
    harness.store.events().filter(event => event.type === 'attention.needed' && event.reason === 'approve-spec:1')
      .length;
  const requestsBefore = requests();

  const second = harness.run();
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  assert.equal(requests(), requestsBefore, 'resuming does not raise the decision again');
  assert.equal(harness.orca.starts.length, startsBefore + 2, 'only build and review start after resuming');
  harness.command({ kind: 'accept' });
  assert.equal(await second, 0);
  assert.equal(await harness.run(), 0, 'a finished task does nothing when driven again');
});

test('a worker question is recorded, answered through a command and relayed to Orca', async () => {
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: async context => {
        const answer = await context.ask('Should greet trim whitespace? Default: no.');
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded', body: `Answer was ${answer}` };
      },
    }),
  );
  const driver = harness.run();
  const asked = await harness.until(state => state.questions.size === 1, 'a question');
  const [messageId] = [...asked.questions.keys()];
  harness.command({ kind: 'reply', messageId: messageId ?? '', body: 'No, keep it as is.' });
  const approved = await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  assert.equal(harness.orca.replies.get(messageId ?? ''), 'No, keep it as is.');
  assert.equal([...approved.questions.values()][0]?.answered, true);
  harness.command({ kind: 'abandon' });
  await driver;
});

test('a worker that exits without reporting waits for the user to retry', async () => {
  let specStarts = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        specStarts++;
        if (specStarts === 1) {
          h.orca.liveness.set(context.dispatchId, 'exited');
          return 'hang';
        }
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const waiting = await harness.until(
    state => state.attention?.reason.startsWith('stage-failed:spec:1') ?? false,
    'exit noticed',
  );
  assert.deepEqual(waiting.attention?.options, ['retry', 'abandon']);
  harness.command({ kind: 'retry' });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval after retry');
  const retry = harness.orca.starts[1];
  assert.equal(retry?.request.retryOf, 'dispatch_1');
  harness.command({ kind: 'abandon' });
  await driver;
  assert.ok(harness.orca.released.includes('dispatch_1'));
});

test('abandoning while a worker runs stops it', async () => {
  const harness = await createHarness(h => goodWorkers(h, { spec: () => 'hang' }));
  const driver = harness.run();
  await harness.until(state => state.stages.get('spec:1')?.dispatches.length === 1, 'spec started');
  harness.command({ kind: 'abandon', reason: 'changed my mind' });
  assert.equal(await driver, 0);
  assert.deepEqual(harness.orca.stopped, ['dispatch_1']);
  assert.equal(harness.state().finished?.outcome, 'abandoned');
});

test('a spec revision carries the questions the user already answered', async () => {
  let asked = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: async context => {
        if (asked++ === 0) await context.ask('Should greet trim whitespace?');
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const questioned = await harness.until(state => state.questions.size === 1, 'a question');
  const [messageId] = [...questioned.questions.keys()];
  harness.command({ kind: 'reply', messageId: messageId ?? '', body: 'Yes, trim it.' });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  harness.command({ kind: 'revise', feedback: 'Mention Unicode whitespace.' });
  await harness.until(state => state.attention?.reason === 'approve-spec:2', 'second approval');
  const revision = harness.orca.starts.find(start => start.title.startsWith('Spec revision'));
  assert.match(revision?.spec ?? '', /already answered[\s\S]*Should greet trim whitespace\?[\s\S]*Yes, trim it\./);
  assert.match(revision?.spec ?? '', /Mention Unicode whitespace./);
  harness.command({ kind: 'abandon' });
  await driver;
});
