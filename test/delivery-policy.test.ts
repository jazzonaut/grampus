// Delivery policy must remove routine gates without relaxing evidence or losing restart bounds.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recipeSchema, deliverySchema } from '../src/domain/recipe.js';
import { parseReviewReport } from '../src/domain/review.js';
import { DriverCore } from '../src/pipeline/driver-core.js';
import {
  BudgetExhausted,
  checkDeadline,
  checkDispatchBudget,
  selectedRepairAssignment,
} from '../src/pipeline/delivery.js';
import { measureDelivery } from '../src/measure/delivery.js';
import { foldEvents } from '../src/pipeline/state.js';
import { summarise } from '../src/pipeline/status.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { createHarness, goodWorkers, outputPath, reviewJson, specText, worktreeOf } from './helpers/task-fixture.js';

test('unattended delivery corrects a malformed review and finishes without user commands', async () => {
  const recipe = recipeSchema.parse({
    ...pipelineRecipe,
    delivery: {
      mode: 'unattended',
      maxSeconds: 1800,
      maxCostUsd: null,
      reportRetries: 1,
      investigations: 1,
      stageRetries: 1,
    },
  });
  let reviews = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          writeFileSync(outputPath(context.spec), reviews++ === 0 ? '{broken' : reviewJson('approve'));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.finished !== null, 'unattended completion');
    assert.equal(state.finished?.outcome, 'accepted');
    assert.equal(state.finished?.override, false);
    assert.equal(state.commands.length, 0);
    assert.equal(state.decisions.size, 1, 'report correction must not rebuild');
    assert.equal(reviews, 2);
    assert.ok(h.store.events().some(e => String(e.type) === 'policy.decided'));
    assert.equal(await driver, 0);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('unattended recipes require independent review and reject unbounded budgets', () => {
  assert.equal(deliverySchema.parse({}).maxSeconds, 3600);
  assert.equal(
    recipeSchema.safeParse({ ...pipelineRecipe, build: { agent: 'claude' }, delivery: { mode: 'unattended' } }).success,
    false,
  );
  assert.equal(
    recipeSchema.safeParse({ ...pipelineRecipe, review: null, delivery: { mode: 'unattended' } }).success,
    false,
  );
  assert.equal(
    recipeSchema.safeParse({ ...pipelineRecipe, delivery: { mode: 'unattended', maxSeconds: 0 } }).success,
    false,
  );
});

test('successive technical spec corrections have a separate allowance from report formatting', async () => {
  let specs = 0;
  let reports = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        spec: context => {
          writeFileSync(
            outputPath(context.spec),
            ++specs < 3 ? specText([{ name: 'missing test', command: 'node absent.test.js' }]) : specText(),
          );
          return { outcome: 'succeeded' };
        },
        'spec-review': context => {
          writeFileSync(outputPath(context.spec), ++reports === 1 ? '{bad' : reviewJson('approve'));
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', specRevisions: 3, reportRetries: 1 } }),
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.finished !== null || s.attention !== null, 'successive corrections');
    assert.equal(state.finished?.outcome, 'accepted');
    assert.equal(state.commands.length, 0);
    assert.equal(specs, 3);
    assert.equal(reports, 4);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('unattended stage deadline replaces a stopped worker once without chat commands', async () => {
  let builds = 0;
  const h = await createHarness(
    h => goodWorkers(h, { build: context => (++builds === 1 ? 'hang' : goodWorkers(h)(context)) }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', stageSeconds: 2, stageRetries: 1 } }),
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.finished !== null, 'stalled worker recovery');
    assert.equal(state.finished?.outcome, 'accepted');
    assert.equal(state.commands.length, 0);
    assert.equal(builds, 2);
    assert.equal(h.orca.stopped.length, 1);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('an unexecutable spec check is corrected even when its reviewer approves it', async () => {
  let specs = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        spec: context => {
          writeFileSync(
            outputPath(context.spec),
            specs++ ? specText() : specText([{ name: 'missing test', command: 'node missing.test.js' }]),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } }),
  );
  const driver = h.run();
  try {
    await h.until(s => s.finished !== null, 'baseline correction');
    assert.equal(h.state().specs.length, 2);
    assert.equal(h.state().commands.length, 0);
    assert.equal(h.state().finished?.outcome, 'accepted');
    assert.equal(h.state().policyDecisions.has('approve-spec:1'), false);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('unknown coverage receives bounded investigation, never an automatic pass', async () => {
  const recipe = recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } });
  let reviews = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          reviews++;
          writeFileSync(outputPath(context.spec), reviewJson('unknown'));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  let driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'escalate:0', 'bounded investigation');
    assert.equal(reviews, 2);
    assert.equal(h.state().finished, null);
    h.orca.failNextCheck = true;
    assert.equal(await driver, 1);
    driver = h.run();
    await h.until(s => s.lastStop === null, 'resumed decision');
    assert.equal(reviews, 2, 'restart must not replenish investigation allowance');
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('a concrete correctness note cannot pass unattended delivery without a tested disposition', async () => {
  const recipe = recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } });
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          writeFileSync(
            outputPath(context.spec),
            reviewJson('approve', [
              {
                severity: 'note',
                title: 'Buffered input may replay',
                file: 'greet.js',
                line: 1,
                scenario: 'Reconnect while a packet is queued',
                detail: 'Not investigated.',
              },
            ]),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.attention?.reason === 'escalate:0', 'unresolved correctness concern');
    assert.match(state.decisions.get(0)?.reasons.join() ?? '', /correctness concerns remain unresolved/);
    assert.equal(state.finished, null);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('spec report correction does not ask for approval or rewrite the spec', async () => {
  let reports = 0;
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        'spec-review': context => {
          writeFileSync(outputPath(context.spec), reports++ ? reviewJson('approve') : '{bad');
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } }),
  );
  const driver = h.run();
  try {
    await h.until(s => s.finished !== null, 'spec report recovery');
    assert.equal(h.state().specs.length, 1);
    assert.equal(h.state().commands.length, 0);
    assert.equal(reports, 2);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('spending uncertainty stops dispatch and elapsed budget survives restart', async () => {
  const h = await createHarness(
    h => goodWorkers(h),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { maxCostUsd: 1 } }),
  );
  const core = new DriverCore(h.store, h.orca, () => {});
  core.record({ type: 'stage.created', key: 'build:0', stage: 'build', round: 0, orcaTaskId: 'unknown' });
  core.record({
    type: 'stage.started',
    key: 'build:0',
    dispatchId: 'missing-transcript',
    assignment: pipelineRecipe.build,
    reusedHandle: null,
    launch: null,
  });
  await assert.rejects(checkDispatchBudget(core, 'repair:1'), BudgetExhausted);
  assert.equal(h.orca.starts.length, 0);
  core.state.createdAt = new Date(0).toISOString();
  assert.throws(() => checkDeadline(core), BudgetExhausted);
  const replay = foldEvents(
    core.events.map(event => (event.type === 'task.created' ? { ...event, at: new Date(0).toISOString() } : event)),
  );
  assert.equal(replay.recipe.delivery?.maxSeconds, deliverySchema.parse({}).maxSeconds);
});

test('fallback follows stagnant failure counts and remains selected after replay', async () => {
  const fallback = { agent: 'codex' as const, model: 'stronger' };
  const h = await createHarness(h => goodWorkers(h), {
    ...pipelineRecipe,
    repair: { ...pipelineRecipe.repair, fallback, stagnantRounds: 2 },
  });
  const core = new DriverCore(h.store, h.orca, () => {});
  core.record({
    type: 'round.decided',
    round: 0,
    specVersion: 1,
    sha: 'first',
    decision: 'repair',
    reasons: ['failed check'],
  });
  assert.deepEqual(selectedRepairAssignment(core, 1), pipelineRecipe.build);
  core.record({
    type: 'round.decided',
    round: 1,
    specVersion: 1,
    sha: 'second',
    decision: 'repair',
    reasons: ['failed check'],
  });
  assert.deepEqual(selectedRepairAssignment(core, 2), fallback);
  const resumed = new DriverCore(h.store, h.orca, () => {});
  assert.deepEqual(selectedRepairAssignment(resumed, 3), fallback);
  assert.equal(
    resumed.events.filter(event => event.type === 'policy.decided' && event.action === 'fallback').length,
    1,
  );
});

test('selection time and external technical interventions are distinct from verified delivery', async () => {
  const h = await createHarness(h => goodWorkers(h));
  const base = Date.parse(h.state().createdAt);
  const events = [
    ...h.store.events(),
    {
      type: 'round.decided' as const,
      round: 0,
      specVersion: 1,
      sha: 'sha',
      decision: 'ready' as const,
      reasons: [],
      at: new Date(base + 1000).toISOString(),
    },
    {
      type: 'attention.needed' as const,
      reason: 'ready:0',
      detail: 'ready',
      options: ['accept' as const],
      at: new Date(base + 1000).toISOString(),
    },
  ];
  const result = measureDelivery(foldEvents(events), events, base + 100_000);
  assert.equal(result.firstVerifiedMs, 1000);
  assert.equal(result.selectionWaitMs, 99_000);
  assert.equal(result.externalInterventions, 0);
  assert.equal(result.firstPass, true);
  assert.equal(parseReviewReport(reviewJson('approve')).verdict, 'approve');
});

test('repository-grounded worker questions are answered by policy without user commands', async () => {
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        build: async context => {
          assert.match(await context.ask('Which file owns greet?'), /greet.js/);
          return goodWorkers(h)(context);
        },
        question: context => {
          assert.equal(summarise(h.state()).questions.length, 0, 'automatic investigation must not page the user');
          writeFileSync(
            outputPath(context.spec),
            JSON.stringify({
              disposition: 'answer',
              body: 'Implement the greeting in greet.js.',
              references: ['greet.js'],
            }),
          );
          return { outcome: 'succeeded' };
        },
      }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } }),
  );
  const driver = h.run();
  try {
    await h.until(s => s.finished !== null, 'automatic answer and completion');
    assert.equal(h.state().commands.length, 0);
    assert.equal(h.store.events().filter(event => event.type === 'question.answered').length, 1);
    assert.equal(h.orca.replies.size, 1);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('budget exhaustion stops a running worker and records incomplete rather than accepted', async () => {
  const h = await createHarness(
    h => goodWorkers(h, { build: () => 'hang' }),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended', maxSeconds: 8 } }),
  );
  const driver = h.run();
  try {
    const state = await h.until(s => s.finished !== null, 'budget stop');
    assert.equal(state.finished?.outcome, 'incomplete');
    assert.equal(state.finished?.override, false);
    assert.ok(h.store.events().some(event => event.type === 'task.finished' && event.reason?.includes('budget')));
    assert.equal(await driver, 0);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('review probes execute in an isolated checkout and retain their real failure', async () => {
  const recipe = recipeSchema.parse({
    ...pipelineRecipe,
    repair: { ...pipelineRecipe.repair, maxRounds: 0 },
    delivery: { mode: 'unattended' },
  });
  const h = await createHarness(
    h =>
      goodWorkers(h, {
        review: context => {
          const report = parseReviewReport(
            reviewJson('changes', [
              {
                severity: 'blocking',
                title: 'Boundary regression',
                file: 'greet.js',
                line: 1,
                scenario: 'A deliberately failing fixture proves probe execution',
              },
            ]),
          );
          report.probes = [
            {
              scenario: 'Boundary reproduction',
              suggestedPath: 'test/boundary.test.js',
              command: 'node test/boundary.test.js',
              source: "import assert from 'node:assert/strict'; assert.fail('real probe failure');",
              regressionTest: null,
            },
          ];
          writeFileSync(outputPath(context.spec), JSON.stringify(report));
          return { outcome: 'succeeded' };
        },
      }),
    recipe,
  );
  const driver = h.run();
  try {
    await h.until(s => s.attention?.reason === 'escalate:0', 'probe failure');
    const probe = h.store.events().find(event => event.type === 'review.probe');
    assert.equal(probe?.type === 'review.probe' && probe.result.passed, false);
    assert.equal(probe?.type === 'review.probe' && probe.result.exitCode, 1);
    assert.equal(existsSync(join(worktreeOf(h), 'test/boundary.test.js')), false);
    assert.equal(h.state().finished, null);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});
