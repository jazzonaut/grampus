// Executed review probes must survive beyond the reviewer's process before readiness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageProblems, parseReviewReport } from '../src/domain/review.js';
import { retainReviewProbes } from '../src/pipeline/review-probes.js';
import { commitAll, createRepository, write } from './helpers/task-fixture.js';
import { headSha } from '../src/git/git.js';

test('a useful uncommitted review probe becomes an actionable regression requirement', () => {
  const report = parseReviewReport(
    JSON.stringify({
      verdict: 'approve',
      summary: 'Behaviour verified',
      findings: [],
      requestCoverage: { verdict: 'covered', rationale: 'Executed the host journey.' },
      probes: [
        {
          scenario: 'Consecutive departures preserve standings',
          suggestedPath: 'test/standings.test.js',
          command: 'node --test test/standings.test.js',
          source: "assert.deepEqual(results, ['A', 'B']);",
          regressionTest: null,
        },
      ],
    }),
  );
  assert.match(coverageProblems(report).join('\n'), /Consecutive departures preserve standings/);
  assert.match(coverageProblems(report).join('\n'), /assert.deepEqual/);
});

test('omitted probes remain pending and claimed tests must exist at the reviewed commit', async () => {
  const repo = await createRepository();
  const previous = parseReviewReport(
    JSON.stringify({
      verdict: 'approve',
      summary: '',
      findings: [],
      probes: [
        {
          scenario: 'retain standings',
          suggestedPath: 'test/standings.test.js',
          command: 'node test/standings.test.js',
          source: 'assert()',
          regressionTest: null,
        },
      ],
    }),
  );
  const report = parseReviewReport(JSON.stringify({ verdict: 'approve', summary: '', findings: [], probes: [] }));
  await retainReviewProbes(repo, await headSha(repo), report, [previous]);
  assert.equal(report.probes?.length, 1);
  const probe = report.probes[0]!;
  probe.regressionTest = { file: 'test/standings.test.js', test: 'retains standings' };
  await assert.rejects(retainReviewProbes(repo, await headSha(repo), report));
  write(repo, 'test/standings.test.js', '// retains standings\n');
  await assert.rejects(retainReviewProbes(repo, await headSha(repo), report), 'uncommitted files do not count');
  await commitAll(repo, 'Add regression');
  await retainReviewProbes(repo, await headSha(repo), report);
});
