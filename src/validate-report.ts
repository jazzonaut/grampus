// Worker-side report validation uses the same parser and coverage contract as the driver.
import { readFileSync } from 'node:fs';
import { parseReviewReport, validateCoverage } from './domain/review.js';
import { parseSpec } from './domain/spec.js';
import { headSha } from './git/git.js';
import { validateRegressionReference } from './pipeline/review-probes.js';

try {
  const [path, kind, specPath] = process.argv.slice(2);
  if (!path || !['spec', 'code'].includes(kind ?? ''))
    throw new Error('Usage: validate-report <report.json> <spec|code> [spec.md]');
  const report = parseReviewReport(readFileSync(path, 'utf8'));
  if (kind === 'code' && !specPath) throw new Error('Code review requires the approved spec path.');
  validateCoverage(
    report,
    kind === 'code' && specPath
      ? parseSpec(readFileSync(specPath, 'utf8')).block.acceptance.map(item => item.id)
      : undefined,
  );
  const regressions = report.probes?.flatMap(probe => (probe.regressionTest ? [probe.regressionTest] : [])) ?? [];
  if (kind === 'code' && regressions.length) {
    const cwd = process.cwd();
    const sha = await headSha(cwd);
    for (const regression of regressions) await validateRegressionReference(cwd, sha, regression);
  }
  console.log('Report format and coverage mapping are valid. Behavioural evidence still requires driver verification.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
