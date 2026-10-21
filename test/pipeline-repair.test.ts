import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import {
  commitAll,
  createHarness,
  goodWorkers,
  outputPath,
  reviewJson,
  write,
  worktreeOf,
  type Harness,
} from './helpers/task-fixture.js';

async function approveAndWait(harness: Harness, reason: string) {
  await harness.until(state => state.attention?.reason === 'approve-spec:1', 'spec approval');
  harness.command({ kind: 'approve', specVersion: 1 });
  return harness.until(state => state.attention?.reason === reason, reason);
}

test('a failing check goes to a repair round that continues the builder conversation', async () => {
  let builds = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      build: async () => {
        builds++;
        const worktree = worktreeOf(h);
        write(worktree, 'greet.js', "export function greet(name) {\n  return 'Hello ' + name;\n}\n");
        await commitAll(worktree, 'Almost greet');
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:1');

  assert.equal(builds, 1);
  assert.equal(ready.decisions.get(0)?.decision, 'repair');
  assert.match(ready.decisions.get(0)?.reasons.join() ?? '', /check "greet" failed/);
  assert.equal(ready.decisions.get(1)?.decision, 'ready');
  const repair = harness.orca.starts.find(start => start.title.startsWith('Repair 1'));
  assert.equal(repair?.request.terminal, 'term_dispatch_3', 'round 1 reuses the builder');
  assert.equal(repair?.request.assignment, undefined);
  const prompt = harness.store.events().find(event => event.type === 'stage.created' && event.key === 'repair:1');
  assert.ok(prompt);
  assert.equal(ready.guard.get(1)?.fromSha, ready.guard.get(0)?.sha, 'round 1 is guarded from the previous candidate');
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
});

test('only supported blocking findings send work back; unsupported ones are downgraded', async () => {
  let reviews = 0;
  const harness = await createHarness(h =>
    goodWorkers(h, {
      review: context => {
        reviews++;
        const findings =
          reviews === 1
            ? [
                {
                  severity: 'blocking',
                  title: 'Empty name',
                  file: 'greet.js',
                  line: 2,
                  scenario: "greet('') returns 'Hello, !'",
                },
                { severity: 'blocking', title: 'Vague worry' },
              ]
            : [];
        writeFileSync(outputPath(context.spec), reviewJson(reviews === 1 ? 'changes' : 'approve', findings));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:1');
  assert.equal(ready.reviews.get(0)?.blocking.length, 1);
  assert.equal(ready.reviews.get(0)?.downgraded[0]?.title, 'Vague worry');
  assert.equal(ready.decisions.get(0)?.decision, 'repair');
  const repairTask = harness.store.events().find(event => event.type === 'stage.created' && event.key === 'repair:1');
  assert.ok(repairTask);
  const reviewSecond = harness.orca.starts.filter(start => start.title.startsWith('Review'));
  assert.equal(reviewSecond.length, 2);
  harness.command({ kind: 'accept' });
  await driver;
});

test('after the recipe allows no more rounds the user decides, and accepting records an override', async () => {
  const recipe = { ...standardRecipe, name: 'no-repair', repair: { maxRounds: 0, reuseBuilderRounds: 0 } };
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        build: async () => {
          const worktree = worktreeOf(h);
          write(worktree, 'notes.txt', 'did nothing useful\n');
          await commitAll(worktree, 'No fix');
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  const escalated = await approveAndWait(harness, 'escalate:0');
  assert.deepEqual(escalated.attention?.options, ['continue', 'accept', 'abandon']);
  harness.command({ kind: 'accept' });
  assert.equal(await driver, 0);
  assert.equal(harness.state().finished?.override, true);
});

test('continue grants one more round with the user guidance in the repair prompt', async () => {
  const recipe = { ...standardRecipe, name: 'no-repair', repair: { maxRounds: 0, reuseBuilderRounds: 0 } };
  let attempt = 0;
  const harness = await createHarness(
    h =>
      goodWorkers(h, {
        build: async () => {
          attempt++;
          const worktree = worktreeOf(h);
          write(worktree, 'notes.txt', 'first try\n');
          await commitAll(worktree, 'First try');
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = harness.run();
  await approveAndWait(harness, 'escalate:0');
  harness.command({ kind: 'continue', guidance: 'Use a template literal.' });
  const ready = await harness.until(state => state.attention?.reason === 'ready:1', 'ready after guidance');
  assert.equal(attempt, 1);
  const repair = harness.orca.starts.find(start => start.title.startsWith('Repair 1'));
  assert.equal(repair?.request.assignment?.agent, 'codex', 'a fresh worker after the reuse allowance');
  assert.equal(ready.decisions.get(1)?.decision, 'ready');
  harness.command({ kind: 'accept' });
  await driver;
});

test('deleting a test fails the round even when the checks pass', async () => {
  const harness = await createHarness(h =>
    goodWorkers(h, {
      build: async () => {
        const worktree = worktreeOf(h);
        const { rmSync } = await import('node:fs');
        rmSync(`${worktree}/test/greet.test.js`);
        write(worktree, 'test/other.test.js', 'console.log("ok")\n');
        await commitAll(worktree, 'Replace the test');
        return { outcome: 'succeeded' };
      },
      spec: context => {
        writeFileSync(outputPath(context.spec), specTextWith('node -e "process.exit(0)"'));
        return { outcome: 'succeeded' };
      },
    }),
  );
  const driver = harness.run();
  const ready = await approveAndWait(harness, 'ready:1');
  assert.match(ready.guard.get(0)?.guard.violations.join() ?? '', /Test file deleted: test\/greet.test.js/);
  assert.equal(ready.decisions.get(0)?.decision, 'repair');
  harness.command({ kind: 'abandon' });
  await driver;
});

function specTextWith(command: string): string {
  return `# Spec\n\n\`\`\`grampus\n${JSON.stringify({ checks: [{ name: 'trivial', command }] })}\n\`\`\`\n`;
}
