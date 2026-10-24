// Policy preflight must expose differences and keep model experiments intact under common authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonRecipes, comparisonPolicyPreview } from '../src/compare/policy.js';
import { deliverySchema, standardRecipe } from '../src/domain/recipe.js';
import { useTestSettings } from './helpers/task-fixture.js';

test('common comparison mandate preserves stage assignments and does not mutate saved recipes', () => {
  const cheap = { ...standardRecipe, name: 'custom', delivery: undefined };
  useTestSettings({ recipes: [cheap] });
  const names = ['standard-codex', 'custom'];
  assert.match(comparisonPolicyPreview(comparisonRecipes(names)), /Policy differences are retained/);
  const policy = deliverySchema.parse({ mode: 'unattended', maxSeconds: 3600 });
  const resolved = comparisonRecipes(names, policy);
  assert.deepEqual(
    resolved.map(recipe => recipe.delivery),
    [policy, policy],
  );
  assert.deepEqual(resolved[1]?.build, cheap.build);
  assert.deepEqual(resolved[1]?.repair, cheap.repair);
  assert.equal(cheap.delivery, undefined);
  assert.match(comparisonPolicyPreview(resolved), /All entries use the same/);
  const shared = comparisonRecipes(names, policy, true);
  assert.deepEqual(shared[0]?.testsFirst, standardRecipe.spec);
  assert.equal(shared[1]?.testsFirst, null);
  assert.equal(standardRecipe.testsFirst, null);
});

test('common unattended policy rejects recipes without independent review before launch', () => {
  useTestSettings({ recipes: [{ ...standardRecipe, name: 'unsafe', delivery: undefined, review: null }] });
  assert.throws(
    () => comparisonRecipes(['standard-codex', 'unsafe'], deliverySchema.parse({ mode: 'unattended' })),
    /independent/,
  );
});
