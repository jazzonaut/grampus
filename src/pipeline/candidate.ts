// One binding for the final candidate. Consumers must not silently use the pre-polish verification.
import type { CheckResult, GuardResult, ReviewResult } from '../domain/events.js';
import type { PolishRecord, SpecVersion, TaskState } from './state.js';

export interface Candidate {
  sha: string;
  round: number;
  specVersion: number;
  results: CheckResult[];
  guard: GuardResult | null;
  review: ReviewResult | null;
  polished: boolean;
}

/** Resolve the last checked candidate, including failed checks; readiness remains a separate decision. */
export function finalCandidate(state: TaskState): Candidate | null {
  const rounds = [...state.verify.keys()];
  if (!rounds.length) return null;
  const round = Math.max(...rounds);
  const checked = state.verify.get(round);
  const spec = state.specs.at(-1);
  if (!checked || !spec || checked.specVersion !== spec.version || !completeChecks(checked.results, spec)) return null;
  const specVersion = spec.version;
  if ([...state.stages.values()].some(stage => ['build', 'repair'].includes(stage.stage) && stage.round > round))
    return null;
  const guard = state.guard.get(round);
  const review = state.reviews.get(round);
  const decision = state.decisions.get(round);
  if (decision && !sameBinding(decision, checked)) return null;
  if (!guard || guard.sha !== checked.sha || guard.specVersion !== specVersion) return null;
  if (review && (review.sha !== checked.sha || review.specVersion !== specVersion)) return null;
  const pass = state.polish.get(round);
  if (pass?.decided?.kept) return polishedCandidate(pass, checked.sha, round, spec, review ?? null);
  return {
    sha: checked.sha,
    round,
    specVersion,
    results: checked.results,
    guard: guard.guard,
    review: review ?? null,
    polished: false,
  };
}

function sameBinding(left: { sha: string; specVersion: number }, right: { sha: string; specVersion: number }): boolean {
  return left.sha === right.sha && left.specVersion === right.specVersion;
}

/** Every declared command needs evidence, including on a retained polish. */
function completeChecks(results: readonly CheckResult[], spec: SpecVersion): boolean {
  return (
    results.length === spec.checks.length &&
    spec.checks.every(check => results.some(result => result.name === check.name && result.command === check.command))
  );
}

/** Polish approval preserves the original outcome coverage only through a checked preservation review. */
function polishedCandidate(
  pass: PolishRecord,
  fromSha: string,
  round: number,
  spec: SpecVersion,
  original: ReviewResult | null,
): Candidate | null {
  const { checked, decided } = pass;
  if (
    !checked ||
    !decided ||
    checked.sha !== decided.sha ||
    checked.fromSha !== fromSha ||
    decided.fromSha !== fromSha ||
    checked.specVersion !== spec.version ||
    decided.specVersion !== spec.version
  )
    return null;
  const review = decided.review;
  if (
    !completeChecks(checked.results, spec) ||
    review?.report?.verdict !== 'approve' ||
    decided.maintenance?.verdict !== 'worth-keeping'
  )
    return null;
  return {
    sha: checked.sha,
    round,
    specVersion: spec.version,
    results: checked.results,
    guard: checked.guard,
    review: {
      ...review,
      report: {
        ...review.report,
        requestCoverage: original?.report?.requestCoverage,
        coverage: original?.report?.coverage,
        probes: original?.report?.probes,
      },
    },
    polished: true,
  };
}
