// A passing implementation review must account for the user's outcomes, not only the chosen implementation.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSpec } from '../src/domain/spec.js';
import { parseReviewReport, validateCoverage } from '../src/domain/review.js';
import { builtInRecipes, recipeSchema } from '../src/domain/recipe.js';
import { coverageRecipe, gapReport } from './helpers/coverage-fixture.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { createHarness, goodWorkers, outputPath, reviewJson, specText } from './helpers/task-fixture.js';

test('coverage repair allowance is bounded, defaults to zero and is three in both built-ins', () => {
  for (const recipe of builtInRecipes) assert.equal(recipe.repair.coverageGapRounds, 3);
  const parse = (coverageGapRounds?: unknown) =>
    recipeSchema.parse({
      ...pipelineRecipe,
      repair: {
        maxRounds: 2,
        reuseBuilderRounds: 1,
        ...(coverageGapRounds === undefined ? {} : { coverageGapRounds }),
      },
    });
  assert.equal(parse().repair.coverageGapRounds, 0);
  assert.equal(parse(3).repair.coverageGapRounds, 3);
  assert.equal(parse(5).repair.coverageGapRounds, 5);
  for (const invalid of [-1, 1.5, '3', 6]) assert.throws(() => parse(invalid));
});

for (const scenario of [
  'disabled',
  'unknown-request',
  'unknown-review',
  'unsupported',
  'no-finding',
  'missing-mapping',
] as const) {
  test(`coverage still escalates immediately when ${scenario}`, async () => {
    const report = gapReport();
    if (scenario === 'unknown-request')
      report.requestCoverage = { verdict: 'unknown', rationale: 'Transport unavailable.' };
    if (scenario === 'unknown-review') report.verdict = 'unknown';
    if (scenario === 'unsupported') report.findings = [{ severity: 'blocking', title: 'Vague concern' }];
    if (scenario === 'no-finding') report.findings = [];
    if (scenario === 'missing-mapping') report.coverage = [];
    const h = await createHarness(
      h =>
        goodWorkers(h, {
          review: context => {
            writeFileSync(outputPath(context.spec), JSON.stringify(report));
            return { outcome: 'succeeded' };
          },
        }),
      coverageRecipe(scenario === 'disabled' ? 0 : 3, 2),
    );
    const driver = h.run();
    try {
      await h.until(s => s.attention?.reason === 'approve-spec:1', 'approval');
      h.command({ kind: 'approve', specVersion: 1 });
      await h.until(s => s.attention?.reason === 'escalate:0', 'immediate escalation');
      assert.equal(h.orca.starts.filter(start => start.title.startsWith('Repair')).length, 0);
    } finally {
      h.command({ kind: 'abandon' });
      await driver;
    }
  });
}

test('a specification cannot omit the request-to-acceptance mapping', () => {
  assert.throws(() => parseSpec('```grampus\n{"checks":[{"name":"unit","command":"npm test"}]}\n```'), /acceptance/);
});

test('acceptance scenarios reference approved checks and reviews account for each id exactly once', () => {
  const block = parseSpec(specText()).block;
  const encode = (value: unknown) => `\`\`\`grampus\n${JSON.stringify(value)}\n\`\`\``;
  assert.throws(
    () => parseSpec(encode({ ...block, acceptance: [...block.acceptance, ...block.acceptance] })),
    /unique/,
  );
  assert.throws(
    () => parseSpec(encode({ ...block, acceptance: [{ ...block.acceptance[0], checks: ['missing'] }] })),
    /undeclared check/,
  );
  const report = parseReviewReport(reviewJson('approve'));
  assert.doesNotThrow(() => validateCoverage(report, ['greeting']));
  assert.throws(() => validateCoverage({ ...report, coverage: [] }, ['greeting']), /exactly once/);
  assert.throws(
    () => validateCoverage({ ...report, coverage: [...report.coverage!, ...report.coverage!] }, ['greeting']),
    /exactly once/,
  );
  assert.throws(() => validateCoverage(report, ['another-outcome']), /exactly once/);
});

test('reviewers receive the original request and cannot silently approve missing outcome coverage', async () => {
  const h = await createHarness(h =>
    goodWorkers(h, {
      review: context => {
        assert.ok(context.spec.includes(h.state().request), 'review must receive the original request');
        writeFileSync(
          outputPath(context.spec),
          JSON.stringify({ verdict: 'approve', summary: 'Tests pass.', findings: [] }),
        );
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
    assert.match(state.reviews.get(0)?.error ?? '', /coverage/i);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});

test('an unverified journey remains visible and cannot be declared ready', async () => {
  const h = await createHarness(h =>
    goodWorkers(h, {
      spec: context => {
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      },
      review: context => {
        const report = JSON.parse(reviewJson('approve')) as Record<string, unknown>;
        report['requestCoverage'] = { verdict: 'unknown', rationale: 'Transport reconnection was mocked.' };
        report['coverage'] = [
          {
            acceptanceId: 'greeting',
            status: 'unverified',
            evidence: 'Only a unit test ran.',
            limitations: ['Real transport was not exercised.'],
          },
        ];
        writeFileSync(outputPath(context.spec), JSON.stringify(report));
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
    assert.match(state.decisions.get(0)?.reasons.join() ?? '', /Transport|transport/);
  } finally {
    h.command({ kind: 'abandon' });
    await driver;
  }
});
