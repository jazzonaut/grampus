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
     * Optional pass after a ready round that removes bloat from the change without changing behaviour.
     * Kept only when the guard, the checks and a review of its own diff hold. Recipes saved before it
     * existed have no field and mean off.
     */
    simplify: assignmentSchema.nullable().default(null),
    repair: z
      .object({
        maxRounds: z.number().int().min(0).max(recipeLimits.maxRepairRounds),
        /** Repair agent; omitted means the build assignment. */
        assignment: assignmentSchema.optional(),
        /** Rounds up to this number continue the builder's conversation; later rounds start fresh. */
        reuseBuilderRounds: z.number().int().min(0).max(recipeLimits.maxRepairRounds),
      })
      .strict(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

/**
 * The built-in recipe: Claude specifies and reviews, Codex builds, two repair rounds. The spec review
 * runs at medium effort: at high effort it was the slowest stage and found nothing blocking in six
 * runs. Orca takes an effort only with a model, so it names the Codex model those runs used.
 */
export const standardRecipe: Recipe = {
  name: 'standard',
  spec: { agent: 'claude' },
  specReview: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  testsFirst: null,
  build: { agent: 'codex' },
  review: { agent: 'claude' },
  simplify: null,
  repair: { maxRounds: 2, reuseBuilderRounds: 1 },
};

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
    ...(recipe.simplify ? [recipe.simplify] : []),
  ];
  return editors.every(editor => agentFamily(editor.agent) !== agentFamily(review.agent));
}
