// A stable recipe for pipeline tests, independent of the shipped defaults.
import type { Recipe } from '../../src/domain/recipe.js';

/** Exercise spec review and builder reuse without adding an optional polish stage. */
export const pipelineRecipe: Recipe = {
  name: 'pipeline-test',
  spec: { agent: 'claude' },
  specReview: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  testsFirst: null,
  build: { agent: 'codex' },
  review: { agent: 'claude' },
  polish: null,
  explain: { automatic: false, assignment: { agent: 'claude' } },
  repair: { maxRounds: 2, reuseBuilderRounds: 1 },
};
