// Bind a test writer's explanation of the expected failure to the driver's independently observed log.
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'node:path';
import { keepEvidence, readWorkerFile, workerFile } from './workspace-files.js';
import type { DriverCore } from './driver-core.js';
import { assessCheck } from '../checks/failure.js';
import { reviewLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';

const text = z.string().trim().min(1).max(reviewLimits.textLength);
const reportSchema = z
  .object({
    failures: z
      .array(z.object({ check: text, file: text, test: text, criterion: text, expectedOutput: text }).strict())
      .min(1)
      .max(reviewLimits.findings),
  })
  .strict();

/** Unknown or infrastructure failures never become evidence of a successful tests-first red phase. */
export function recordTestBaseline(core: DriverCore, worktree: string): void {
  if (!core.state.testsFirst || !core.state.baseline || core.state.testBaseline) return;
  const files = core.state.testsFirst.files;
  let claims: z.infer<typeof reportSchema>['failures'] = [];
  let problem = 'No usable test-writer report was recorded.';
  const reportPath = workerFile(worktree, 'tests:0', 'report.json');
  const report = readWorkerFile(reportPath);
  if (report && Buffer.byteLength(report) <= reviewLimits.bytes) {
    try {
      claims = reportSchema.parse(JSON.parse(report)).failures;
      keepEvidence(reportPath, join(core.store.dir, 'tests', 'report.json'));
      problem = 'No matching named test failure and assertion were found in the independently recorded log.';
    } catch {
      claims = []; // Evidence that could not be preserved stays unknown.
    }
  }
  const assessments = core.state.baseline.results.map(result => {
    const observed = assessCheck(result, true);
    if (observed.outcome === 'passed' || observed.outcome === 'execution-error' || observed.outcome === 'incompatible')
      return observed;
    const checkClaims = claims.filter(item => item.check === result.name);
    const log = existsSync(result.logPath) ? normalise(readFileSync(result.logPath, 'utf8')) : '';
    const matched =
      checkClaims.length > 0 && checkClaims.every(claim => files.includes(claim.file) && matchesFailure(log, claim));
    if (observed.outcome === 'behavioural-failure' && matched)
      return {
        name: result.name,
        outcome: 'behavioural-failure' as const,
        reason: checkClaims
          .map(
            claim =>
              `Observed ${claim.file}: ${claim.test}, assertion ${claim.expectedOutput}. Writer attributes it to criterion: ${claim.criterion}; review must confirm causation.`,
          )
          .join(' '),
      };
    return {
      name: result.name,
      outcome: 'unknown' as const,
      reason: problem,
    };
  });
  core.record({
    type: 'tests.baseline',
    specVersion: core.state.baseline.specVersion,
    sha: core.state.baseline.sha,
    assessments,
  });
}

function normalise(text: string): string {
  return stripVTControlCharacters(text).replaceAll('\\', '/').replaceAll('\r\n', '\n');
}

/** Only a runner's named failure section counts; a passing test or unrelated assertion elsewhere cannot match. */
function matchesFailure(log: string, claim: z.infer<typeof reportSchema>['failures'][number]): boolean {
  const markers = [
    ...log.matchAll(/^\s*(?:not ok \d+ - |ok \d+ - |FAIL\s+|PASS\s+|●\s+|_{3,}\s*|Failed\s+|Passed\s+)[^\n]*/gm),
  ];
  return markers.some((marker, index) => {
    const title = marker[0]
      .trim()
      .replace(/\s+_+$/, '')
      .replace(/\s+\[[^\]]*\]$/, '');
    if (/^(?:ok |PASS|Passed)/.test(title) || !title.endsWith(claim.test)) return false;
    const block = log.slice(marker.index, markers[index + 1]?.index ?? log.length);
    return (
      block.includes(normalise(claim.file)) &&
      block.includes(normalise(claim.expectedOutput)) &&
      currentSettings().checkAssertionPatterns.some(pattern => new RegExp(pattern).test(block))
    );
  });
}

/** Expose the limits of the red phase even when subsequent implementation checks pass. */
export function testBaselineNote(core: DriverCore): string {
  const evidence = core.state.testBaseline;
  if (!evidence) return '';
  const proven = evidence.assessments.filter(item => item.outcome === 'behavioural-failure');
  const uncertain = evidence.assessments.filter(item => !['behavioural-failure', 'passed'].includes(item.outcome));
  if (proven.length && !uncertain.length) return '';
  return ` Tests-first baseline: ${proven.length ? 'partially established' : 'no demonstrated behavioural red phase'}. ${uncertain.map(item => `${item.name}: ${item.outcome}. ${item.reason}`).join(' ')} Review the acceptance coverage before accepting.`;
}
