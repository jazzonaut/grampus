// Bind a test writer's explanation of the expected failure to the driver's independently observed log.
import { z } from 'zod';
import { readWorkerFile, workerFile } from './workspace-files.js';
import type { DriverCore } from './driver-core.js';
import { assessCheck } from '../checks/failure.js';
import { logExcerpt } from '../checks/run-checks.js';
import { reviewLimits } from '../config/limits.js';

const text = z.string().trim().min(1).max(reviewLimits.textLength);
const reportSchema = z
  .object({
    failures: z
      .array(z.object({ check: text, criterion: text, expectedOutput: text }).strict())
      .max(reviewLimits.findings),
  })
  .strict();

/** Unknown or infrastructure failures never become evidence of a successful tests-first red phase. */
export function recordTestBaseline(core: DriverCore, worktree: string): void {
  if (!core.state.testsFirst || !core.state.baseline || core.state.testBaseline) return;
  let claims: z.infer<typeof reportSchema>['failures'] = [];
  const report = readWorkerFile(workerFile(worktree, 'tests:0', 'report.json'));
  if (report && Buffer.byteLength(report) <= reviewLimits.bytes) {
    try {
      claims = reportSchema.parse(JSON.parse(report)).failures;
    } catch {
      /* Missing evidence stays unknown. */
    }
  }
  const assessments = core.state.baseline.results.map(result => {
    const observed = assessCheck(result, true);
    if (observed.outcome === 'passed' || observed.outcome === 'execution-error' || observed.outcome === 'incompatible')
      return observed;
    const claim = claims.find(item => item.check === result.name);
    if (claim && logExcerpt(result.logPath).includes(claim.expectedOutput))
      return {
        name: result.name,
        outcome: 'behavioural-failure' as const,
        reason: `Writer attributes the observed failure to criterion: ${claim.criterion}. Output: ${claim.expectedOutput}. Review must confirm that attribution.`,
      };
    return {
      name: result.name,
      outcome: 'unknown' as const,
      reason: 'No test-writer explanation matched the independently recorded failure.',
    };
  });
  core.record({ type: 'tests.baseline', sha: core.state.baseline.sha, assessments });
}
