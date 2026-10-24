// Keep planning approval separate from the commit-bound evidence needed for delivery.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specPrompt, specReviewPrompt, testsFirstPrompt } from '../src/pipeline/prompts.js';

test('spec planning permits future tests while test authoring still requires behavioural failures', () => {
  const writer = specPrompt({
    request: 'Preserve reconnect state and other games',
    specPath: 'spec.md',
    previousSpecPath: null,
    feedback: null,
    rejection: null,
    answered: [],
  });
  const reviewer = specReviewPrompt({
    request: 'Preserve reconnect state and other games',
    specPath: 'spec.md',
    reportPath: 'report.json',
    checksBefore: [],
  });
  for (const prompt of [writer, reviewer]) {
    assert.match(prompt, /Spec approval validates a test plan, not completed implementation evidence/);
    assert.match(prompt, /Do not require test-name inventories, minimum test counts or JSON-report wrappers/);
  }
  assert.match(reviewer, /Missing planned tests alone are not a blocking spec finding/);
  assert.match(reviewer, /Unmapped requested outcomes, unusable commands and infeasible test seams remain blocking/);
  const author = testsFirstPrompt({ specPath: 'spec.md', checks: [], reportPath: 'red.json' });
  assert.match(author, /Missing tools, failed imports and broken test harnesses are not behavioural failures/);
  assert.match(author, /Cover every acceptance scenario/);
});
