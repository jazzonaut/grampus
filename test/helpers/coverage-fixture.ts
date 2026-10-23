// Coverage fixtures shared by validation and pipeline decision tests.
import { recipeSchema } from '../../src/domain/recipe.js';
import { parseReviewReport } from '../../src/domain/review.js';
import { pipelineRecipe } from './recipe-fixture.js';
import { reviewJson } from './task-fixture.js';
/** A test recipe with independently bounded ordinary and coverage repairs. */
export function coverageRecipe(coverageGapRounds: number, maxRounds = 0) {
  return recipeSchema.parse({
    ...pipelineRecipe,
    repair: { ...pipelineRecipe.repair, coverageGapRounds, maxRounds },
  });
}

/** A concrete omitted outcome, including its missing evidence and supported blocker. */
export function gapReport() {
  const report = parseReviewReport(
    reviewJson('changes', [
      {
        severity: 'blocking',
        title: 'Handle an empty name',
        file: 'greet.js',
        line: 2,
        scenario: "greet('') produces an empty greeting rather than the requested fallback.",
      },
    ]),
  );
  report.requestCoverage = { verdict: 'gaps', rationale: 'The original request includes an empty-name fallback.' };
  report.coverage = [
    {
      acceptanceId: 'greeting',
      status: 'unverified',
      evidence: 'Only the named greeting was exercised.',
      limitations: ['Add a real empty-name journey.'],
    },
  ];
  return report;
}
