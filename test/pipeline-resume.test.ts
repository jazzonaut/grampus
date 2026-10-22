import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { currentSettings, useSettings } from '../src/config/settings.js';
import type { TaskState } from '../src/pipeline/state.js';
import { createHarness, goodWorkers, outputPath, roleOf, specText } from './helpers/task-fixture.js';

const approvalWithReview = (state: TaskState) =>
  state.attention?.reason === 'approve-spec:1' && state.specReviews.has(1);

test('a lost worker-start response is replayed with the same request id', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  harness.orca.failNextStarts = 1;
  const driver = harness.run();
  await harness.until(approvalWithReview, 'approval');
  const starts = harness.orca.mutations.filter(mutation => mutation.name === 'worker-start');
  assert.deepEqual(
    starts.map(mutation => mutation.replayed),
    [false, true, false],
    'the spec start is replayed by request id, then the spec review starts once',
  );
  assert.equal(harness.orca.starts.length, 2, 'no duplicate spec writer');
  assert.equal(harness.state().lastStop, null, 'the driver carried on');
  harness.command({ kind: 'abandon' });
  assert.equal(await driver, 0);
});

test('an Orca that stays uncertain stops the driver, and rerunning replays the same request', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  harness.orca.failNextStarts = currentSettings().orcaRetries + 1;
  assert.equal(await harness.run(), 1, 'the driver stops instead of guessing');
  assert.match(harness.state().lastStop?.reason ?? '', /worker-start response lost/);
  assert.equal(harness.orca.starts.length, 1, 'Orca did start the worker');

  const driver = harness.run();
  await harness.until(approvalWithReview, 'approval after resuming');
  const replays = harness.orca.mutations.filter(mutation => mutation.name === 'worker-start' && mutation.replayed);
  assert.equal(replays.length, currentSettings().orcaRetries + 1, 'every repeat replays the one request');
  assert.equal(harness.orca.starts.length, 2, 'no duplicate spec writer');
  harness.command({ kind: 'abandon' });
  await driver;
});

test('an unreachable Orca is waited out without stopping the driver', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  await harness.until(approvalWithReview, 'approval');
  harness.orca.uncertainChecks = currentSettings().orcaRetries;
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  harness.orca.uncertainReleases = 1;
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  const events = harness.store.events();
  assert.ok(!events.some(event => event.type === 'driver.stopped'), 'no stop was recorded');
  const released = events.find(event => event.type === 'workers.released');
  assert.deepEqual(released?.type === 'workers.released' ? released.failures : null, [], 'the release was repeated');
  assert.equal(
    events.filter(event => event.type === 'orca.uncertain').length,
    currentSettings().orcaRetries + 1,
    'every repeat is recorded for the System page',
  );
});

test('a busy Orca is waited out, however long it stays busy', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  await harness.until(approvalWithReview, 'approval');
  // More busy checks and starts than any repeat budget: a refused call applied nothing, so waiting costs nothing.
  harness.orca.busyChecks = currentSettings().orcaRetries * 3;
  harness.orca.busyStarts = currentSettings().orcaRetries * 3;
  harness.command({ kind: 'approve', specVersion: 1 });
  await harness.until(state => state.attention?.reason === 'ready:0', 'ready');
  assert.equal(harness.orca.busyChecks, 0, 'every busy check was waited out');
  assert.equal(harness.orca.busyStarts, 0, 'every busy start was waited out');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  const events = harness.store.events();
  assert.ok(!events.some(event => event.type === 'driver.stopped'), 'no stop was recorded');
  assert.ok(!events.some(event => event.type === 'stage.start_failed'), 'a busy start is not a failed start');
  const spells = events.filter(event => event.type === 'orca.busy').length;
  assert.ok(
    spells >= 1 && spells < currentSettings().orcaRetries * 3,
    'a busy spell is recorded once, not per refusal',
  );
  assert.equal(events.filter(event => event.type === 'orca.room').length, spells, 'every spell records its end');
});

test('a reply Orca refuses is recorded as refused and the driver carries on', async () => {
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: async context => {
        await context.ask('Should greet trim whitespace?');
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const asked = await harness.until(state => state.questions.size === 1, 'a question');
  const [messageId = ''] = [...asked.questions.keys()];
  harness.orca.refuseReplies = true;
  harness.command({ kind: 'reply', messageId, body: 'No.' });
  const refused = await harness.until(state => state.refusals.length === 1, 'the refusal');
  assert.match(refused.refusals[0]?.reason ?? '', /Orca refused the reply: No open question/);
  assert.equal(refused.questions.get(messageId)?.answered, false, 'the question is still open');

  harness.orca.refuseReplies = false;
  harness.command({ kind: 'reply', messageId, body: 'No.' });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval after a second answer');
  assert.equal(harness.state().lastStop, null);
  harness.command({ kind: 'abandon' });
  assert.equal(await driver, 0);
});

test('a worker that goes quiet asks the user, and retry replaces it', async () => {
  let specStarts = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        if (specStarts++ === 0) return 'hang';
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  useSettings({ ...currentSettings(), stalledWorkerMs: 150 });
  const driver = harness.run();
  const quiet = await harness.until(state => state.attention?.reason === 'stage-quiet:spec:1:1', 'quiet worker');
  assert.deepEqual(quiet.attention?.options, ['retry', 'abandon']);
  harness.command({ kind: 'retry' });
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval after retry');
  assert.equal(harness.orca.stopped[0], 'dispatch_1', 'the quiet worker was stopped');
  assert.equal(harness.orca.starts[1]?.request.retryOf, 'dispatch_1');
  harness.command({ kind: 'abandon' });
  assert.equal(await driver, 0);
});

test('a quiet worker that reports after all withdraws the request', async () => {
  const gate = { open: () => {} };
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: async context => {
        await new Promise<void>(resolve => {
          gate.open = resolve;
        });
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  useSettings({ ...currentSettings(), stalledWorkerMs: 150 });
  const driver = harness.run();
  await harness.until(state => state.attention?.reason === 'stage-quiet:spec:1:1', 'quiet worker');
  gate.open();
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'approval');
  const events = harness.store.events();
  assert.ok(events.some(event => event.type === 'attention.withdrawn' && event.reason === 'stage-quiet:spec:1:1'));
  assert.equal(harness.orca.starts.filter(start => roleOf(start.title) === 'spec').length, 1, 'not replaced');
  harness.command({ kind: 'abandon' });
  assert.equal(await driver, 0);
});

test('a worker waiting for an answer is not quiet', async () => {
  const harness = await createHarness(h =>
    goodWorkers(h, {
      spec: async context => {
        await context.ask('Should greet trim whitespace?');
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
    }),
  );
  useSettings({ ...currentSettings(), stalledWorkerMs: 50 });
  const driver = harness.run();
  await harness.until(state => state.questions.size === 1, 'a question');
  await sleep(300);
  assert.equal(harness.state().attention, null, 'the wait is for the user, not the worker');
  harness.command({ kind: 'abandon' });
  assert.equal(await driver, 0);
});

test('a driver whose lock another driver took stops without writing', async () => {
  const harness = await createHarness(h => goodWorkers(h));
  const driver = harness.run();
  await harness.until(approvalWithReview, 'approval');
  const lock = join(harness.store.dir, 'driver.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'another-driver' }));
  const recorded = harness.store.events().length;
  harness.command({ kind: 'approve', specVersion: 1 });
  assert.equal(await driver, 1);
  assert.equal(harness.store.events().length, recorded, 'nothing was written after the lock was lost');
  assert.match(readFileSync(lock, 'utf8'), /another-driver/, "the other driver's lock is kept");
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
  // Time spent waiting for the user's answer is not agent time.
  const spec = harness.state().measurements?.find(item => item.key === 'spec:1');
  assert.ok(spec?.durationMs !== null && spec?.waitingMs !== null && spec?.agentMs !== null);
  assert.ok((spec?.waitingMs ?? 0) > 0, 'the wait for the answer is measured');
  assert.equal(spec?.agentMs, (spec?.durationMs ?? 0) - (spec?.waitingMs ?? 0));
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
