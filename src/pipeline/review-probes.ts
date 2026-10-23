// Retain review discoveries until a subsequent candidate contains their regression tests.
import type { ReviewReport } from '../domain/review.js';
import { git } from '../git/git.js';
import { matchesAny } from '../util/glob.js';
import { currentSettings } from '../config/settings.js';
import { reviewLimits } from '../config/limits.js';

/** Carry missing probes forward and validate claimed regressions at the reviewed commit. */
export async function retainReviewProbes(
  cwd: string,
  sha: string,
  report: ReviewReport,
  previous: readonly ReviewReport[] = [],
): Promise<void> {
  const probes = report.probes ?? [];
  for (const prior of previous.flatMap(item => item.probes ?? []))
    if (!probes.some(probe => probe.scenario === prior.scenario)) probes.push(prior);
  if (probes.length > reviewLimits.findings || new Set(probes.map(probe => probe.scenario)).size !== probes.length)
    throw new Error('Review probes must have unique scenarios within the review limit.');
  report.probes = probes;
  for (const probe of probes) {
    const regression = probe.regressionTest;
    if (!regression) continue;
    if (!matchesAny(regression.file, currentSettings().testFilePatterns))
      throw new Error(`Review probe regression is not a recognised test file: ${regression.file}`);
    const source = await git(cwd, ['show', `${sha}:${regression.file}`]);
    if (!source.includes(regression.test))
      throw new Error(`Review probe regression test is missing: ${regression.file}: ${regression.test}`);
  }
}
