// One binding for the final candidate. Consumers must not silently use the pre-polish verification.
import type { CheckResult, GuardResult, ReviewResult } from '../domain/events.js';
import type { TaskState } from './state.js';

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
  const specVersion = state.specs.at(-1)?.version;
  if (!checked || !specVersion) return null;
  const pass = state.polish.get(round);
  if (pass?.decided?.kept) {
    if (!pass.checked || pass.checked.sha !== pass.decided.sha || pass.checked.fromSha !== checked.sha) return null;
    return {
      sha: pass.checked.sha,
      round,
      specVersion,
      results: pass.checked.results,
      guard: pass.checked.guard,
      review: pass.decided.review,
      polished: true,
    };
  }
  return {
    sha: checked.sha,
    round,
    specVersion,
    results: checked.results,
    guard: state.guard.get(round)?.guard ?? null,
    review: state.reviews.get(round) ?? null,
    polished: false,
  };
}
