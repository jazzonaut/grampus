// Recipes: which pipeline stages run and which agent, model and effort each uses. A recipe is data so
// that experiments are configuration changes. A task copies its recipe when it is created, so editing
// a saved recipe never changes a running task.
import { z } from 'zod';
import { recipeLimits } from '../config/limits.js';

/** Orca agent ids Grampus can launch. Each belongs to one model family. */
export const agentSchema = z.enum(['claude', 'codex']);
export type Agent = z.infer<typeof agentSchema>;

/** Model family of an agent, used to keep review independent of the builder. */
export function agentFamily(agent: Agent): 'anthropic' | 'openai' {
  switch (agent) {
    case 'claude':
      return 'anthropic';
    case 'codex':
      return 'openai';
  }
}

/**
 * One stage's launch choice. An omitted model inherits the user's Orca default for that agent.
 * Orca accepts an effort only together with a model.
 */
export const assignmentSchema = z
  .object({
    agent: agentSchema,
    model: z.string().min(1).max(recipeLimits.nameLength).optional(),
    effort: z.string().min(1).max(recipeLimits.nameLength).optional(),
  })
  .strict()
  .refine(value => value.effort === undefined || value.model !== undefined, {
    message: 'effort needs a model',
  });
export type Assignment = z.infer<typeof assignmentSchema>;

export const recipeSchema = z
  .object({
    name: z.string().min(1).max(recipeLimits.nameLength),
    spec: assignmentSchema,
    /** Optional review of the spec before approval. Its findings are shown, never looped. */
    specReview: assignmentSchema.nullable(),
    /** Optional worker that turns spec examples into failing acceptance tests before the build. */
    testsFirst: assignmentSchema.nullable(),
    build: assignmentSchema,
    /** Independent code review; null skips review so its value can be measured. */
    review: assignmentSchema.nullable(),
    /**
     * Optional maintenance pass after a ready round, preserving behaviour. Independent review must
     * approve safety and concrete maintenance benefit. Omission means off.
     */
    polish: assignmentSchema.nullable().default(null),
    /** Change explanation worker and whether the final candidate is explained before acceptance. */
    explain: z
      .object({ automatic: z.boolean(), assignment: assignmentSchema })
      .strict()
      .default({ automatic: false, assignment: { agent: 'claude' } }),
    repair: z
      .object({
        maxRounds: z.number().int().min(0).max(recipeLimits.maxRepairRounds),
        /** Separate automatic allowance for supported coverage findings; zero asks the user immediately. */
        coverageGapRounds: z.number().int().min(0).max(recipeLimits.maxRepairRounds).default(0),
        /** Repair agent; omitted means the build assignment. */
        assignment: assignmentSchema.optional(),
        /** Rounds up to this number continue the builder's conversation; later rounds start fresh. */
        reuseBuilderRounds: z.number().int().min(0).max(recipeLimits.maxRepairRounds),
      })
      .strict(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

/** Default recipe, promoted from economy-codex-4-polish. */
export const standardRecipe: Recipe = {
  name: 'standard-codex',
  spec: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  specReview: null,
  testsFirst: null,
  build: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  review: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  polish: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  explain: { automatic: false, assignment: { agent: 'claude' } },
  repair: {
    maxRounds: 2,
    coverageGapRounds: 3,
    assignment: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    reuseBuilderRounds: 1,
  },
};

/** Mirror of standard-codex, with Claude editing and Codex reviewing. */
export const standardClaudeRecipe: Recipe = {
  name: 'standard-claude',
  spec: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  specReview: null,
  testsFirst: null,
  build: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  review: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  polish: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  explain: { automatic: false, assignment: { agent: 'codex' } },
  repair: {
    maxRounds: 2,
    coverageGapRounds: 3,
    assignment: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    reuseBuilderRounds: 1,
  },
};

/** Built-in recipes, with the default first. Saved recipes cannot shadow these names. */
export const builtInRecipes: readonly Recipe[] = [standardRecipe, standardClaudeRecipe];

/** The assignment that repairs a round. */
export function repairAssignment(recipe: Recipe): Assignment {
  return recipe.repair.assignment ?? recipe.build;
}

/**
 * Whether review comes from a different model family than every editing stage. Same-family review is
 * allowed so it can be measured against cross-family review; the task records which one ran.
 */
export function crossFamilyReview(recipe: Recipe): boolean | null {
  const review = recipe.review;
  if (!review) return null;
  const editors = [
    recipe.build,
    repairAssignment(recipe),
    ...(recipe.testsFirst ? [recipe.testsFirst] : []),
    ...(recipe.polish ? [recipe.polish] : []),
  ];
  return editors.every(editor => agentFamily(editor.agent) !== agentFamily(review.agent));
}
