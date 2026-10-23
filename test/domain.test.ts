import { acceptanceScenarios } from './helpers/task-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtInRecipes,
  crossFamilyReview,
  recipeSchema,
  standardRecipe,
  standardClaudeRecipe,
} from '../src/domain/recipe.js';
import { judgeCodeReview, parseReviewReport } from '../src/domain/review.js';
import { parseSpec } from '../src/domain/spec.js';
import { globToRegExp, matchesAny } from '../src/util/glob.js';

const block = (value: unknown) =>
  `# Spec\n\n\`\`\`grampus\n${JSON.stringify({ acceptance: acceptanceScenarios((value as { checks?: { name: string }[] }).checks?.map(check => check.name)), ...(value as object) })}\n\`\`\`\n`;

test('a spec needs exactly one valid grampus block', () => {
  const spec = parseSpec(block({ checks: [{ name: 'unit', command: 'npm test' }] }));
  assert.deepEqual(spec.block, {
    checks: [{ name: 'unit', command: 'npm test' }],
    protected: [],
    acceptance: acceptanceScenarios(['unit']),
  });
  assert.equal(spec.hash, parseSpec(spec.markdown).hash);
  assert.throws(() => parseSpec('# Spec\nno block'), /exactly one fenced `grampus` JSON block; found 0/);
  assert.throws(() => parseSpec(block({ checks: [] }) + block({ checks: [] })), /found 2/);
  assert.throws(() => parseSpec('```grampus\n{nope\n```\n'), /not valid JSON/);
  assert.throws(() => parseSpec(block({ checks: [] })), /invalid/);
  assert.throws(() => parseSpec(block({ checks: [{ name: 'a', command: 'x' }], extra: 1 })), /invalid/);
  const twice = {
    checks: [
      { name: 'a', command: 'x' },
      { name: 'a', command: 'y' },
    ],
  };
  assert.throws(() => parseSpec(block(twice)), /unique/);
});

test('a CRLF spec parses the same way', () => {
  const spec = parseSpec(block({ checks: [{ name: 'unit', command: 'npm test' }] }).replaceAll('\n', '\r\n'));
  assert.equal(spec.block.checks.length, 1);
});

test('blocking findings need a file, a line and a scenario', () => {
  const report = parseReviewReport(
    JSON.stringify({
      verdict: 'changes',
      summary: 'Two problems.',
      findings: [
        { severity: 'blocking', title: 'Crash on empty', file: 'a.js', line: 3, scenario: 'f("") throws' },
        { severity: 'blocking', title: 'Feels fragile', file: 'a.js' },
        { severity: 'note', title: 'Naming' },
      ],
    }),
  );
  const outcome = judgeCodeReview(report);
  assert.deepEqual(
    outcome.blocking.map(finding => finding.title),
    ['Crash on empty'],
  );
  assert.deepEqual(
    outcome.downgraded.map(finding => finding.title),
    ['Feels fragile'],
  );
  assert.throws(() => parseReviewReport('{"verdict":"maybe","summary":"","findings":[]}'), /invalid/);
  assert.throws(() => parseReviewReport('not json'), /not valid JSON/);
});

test('globs cross directories only with **', () => {
  assert.ok(matchesAny('src/a/b.test.ts', ['**/*.test.*']));
  assert.ok(matchesAny('b.test.ts', ['**/*.test.*']));
  assert.ok(matchesAny('test/x/y.js', ['**/test/**']));
  assert.ok(matchesAny('pkg/test/y.js', ['**/test/**']));
  assert.ok(!matchesAny('src/latest.js', ['**/test/**']));
  assert.ok(!matchesAny('src/a/b.ts', ['src/*.ts']));
  assert.ok(matchesAny('src\\a.ts', ['src/*.ts']), 'Windows separators are normalised');
  assert.equal(globToRegExp('a.b?').test('a.bc'), true);
  assert.equal(globToRegExp('a.b?').test('axbc'), false);
});

test('the standard recipe is valid and its review is cross-family', () => {
  for (const recipe of builtInRecipes) {
    assert.deepEqual(recipeSchema.parse(recipe), recipe);
    assert.equal(crossFamilyReview(recipe), true);
  }
  assert.deepEqual(standardClaudeRecipe.build, standardRecipe.review);
  assert.deepEqual(standardClaudeRecipe.review, standardRecipe.build);
  assert.equal(standardClaudeRecipe.repair.assignment?.effort, standardRecipe.repair.assignment?.effort);
  assert.equal(crossFamilyReview({ ...standardRecipe, review: { agent: 'codex' } }), false);
  assert.equal(crossFamilyReview({ ...standardRecipe, review: null }), null);
  assert.equal(
    crossFamilyReview({ ...standardRecipe, polish: { agent: 'claude' } }),
    false,
    'the polisher edits code, so a same-family polisher makes review same-family',
  );
  const { polish: _polish, ...saved } = standardRecipe;
  assert.equal(recipeSchema.parse(saved).polish, null, 'a recipe saved before polish existed means off');
  assert.throws(
    () => recipeSchema.parse({ ...standardRecipe, build: { agent: 'codex', effort: 'high' } }),
    /effort needs a model/,
  );
});
