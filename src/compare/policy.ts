// Comparison preflight resolves immutable recipe snapshots before any Orca resources are created.
import { availableRecipes } from '../config/settings.js';
import { deliverySchema, recipeSchema, type DeliveryPolicy, type Recipe } from '../domain/recipe.js';

/** Apply a common authority policy without changing models, tests, reviews or repair assignments. */
export function comparisonRecipes(names: readonly string[], delivery?: DeliveryPolicy, sharedTests = false): Recipe[] {
  const unique = [...new Set(names.map(name => name.trim()).filter(Boolean))];
  if (unique.length < 2) throw new Error('A comparison needs at least two different recipes.');
  const known = availableRecipes();
  const policy = delivery ? deliverySchema.parse(delivery) : undefined;
  return unique.map((name, index) => {
    const recipe = known.find(item => item.name === name);
    if (!recipe) throw new Error(`Unknown recipe "${name}". Available: ${known.map(item => item.name).join(', ')}.`);
    return recipeSchema.parse({
      ...recipe,
      ...(policy ? { delivery: policy } : {}),
      ...(sharedTests && index === 0 ? { testsFirst: recipe.spec } : {}),
    });
  });
}

/** Show effective policy differences before launch, including absent mandates. */
export function comparisonPolicyPreview(recipes: readonly Recipe[]): string {
  const rows = recipes.map(
    recipe =>
      `${recipe.name}: ${recipe.delivery ? JSON.stringify(recipe.delivery) : 'supervised; no delivery budget'}; tests first: ${recipe.testsFirst ? JSON.stringify(recipe.testsFirst) : 'off'}`,
  );
  const different = new Set(recipes.map(recipe => JSON.stringify(recipe.delivery ?? null))).size > 1;
  return `Delivery policy before launch:\n${rows.join('\n')}\n${different ? 'Policy differences are retained. Use --delivery unattended --max-seconds 3600 for a common mandate.' : 'All entries use the same delivery policy.'}`;
}
