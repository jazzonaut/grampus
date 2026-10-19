// Owns review progress identities and repair decision evidence. Claims remain reviewer evidence;
// the controller proves artifact changes, complete coverage and the approved shared budget itself.
import { Sessions } from '../../execution/sessions.js';
import type { Reply } from '../../providers/types.js';
import type { GuidedContext, SettleContext } from './context.js';
import type { GuidedState } from './state.js';
import { selectedLenses } from '../../domain/quality-passes.js';
import { GuidedStopError } from './stop-reasons.js';

/** One controller-named blocker, stable for the verdict that introduced it. */
export interface PriorFinding {
  id: string;
  description: string;
  evidence: string;
}

const progressDescriptions = {
  initial: 'first observed failure',
  artifact_changed: 'repository content changed',
  progress: 'earlier blockers resolved with evidence',
  stalled: 'no progress',
  unknown: 'not established by the review evidence',
  ineligible: 'failure is not eligible for automatic repair',
} as const;

/** Blockers include failed selected lenses even when the reviewer supplied no finding list. */
export function blockingFindings(state: GuidedState, reply: Reply, executionId: string): PriorFinding[] {
  const findings = reply.findings.filter(item => item.severity === 'blocking');
  const lenses = selectedLenses(state.plan.quality);
  for (const lens of reply.lenses ?? []) {
    if (lens.verdict !== 'fail' || !lenses.some(item => item.id === lens.lens)) continue;
    findings.push(
      ...(lens.findings.length
        ? lens.findings
        : [
            {
              severity: 'blocking' as const,
              description: lens.summary,
              evidence: `Failed quality lens: ${lens.lens}`,
            },
          ]),
    );
  }
  return findings.map((item, index) => ({
    id: `${executionId}:${index}`,
    description: item.description,
    evidence: item.evidence,
  }));
}

/** The immediately preceding verdict is the frontier; earlier verdicts remain in the full history. */
export function priorBlockingFindings(context: GuidedContext, state: GuidedState): PriorFinding[] {
  const previous = state.reviewCycle.history.at(-1);
  if (!previous) return [];
  const execution = context.executions.get(previous.executionId);
  const reply = new Sessions(context.store).get(execution.sessionId).lastReply;
  const findings = reply ? blockingFindings(state, reply, previous.executionId) : [];
  if (!findings.length)
    throw new GuidedStopError(
      'REVIEW_PROGRESS_UNCONFIRMED',
      'Earlier blocking review evidence is missing; inspect the journal before continuing.',
    );
  return findings;
}

/**
 * Progress is unknown until every prior blocker has a unique, evidenced disposition. An unresolved
 * blocker or an identically described blocker is stalled even when unrelated file bytes changed.
 */
export function reviewProgress(
  prior: PriorFinding[],
  current: PriorFinding[],
  reply: Reply,
): 'progress' | 'stalled' | 'unknown' {
  if (!prior.length) return reply.priorFindings?.length ? 'unknown' : 'progress';
  const claims = reply.priorFindings ?? [];
  if (
    claims.length !== prior.length ||
    new Set(claims.map(item => item.id)).size !== claims.length ||
    prior.some(item => !claims.some(claim => claim.id === item.id))
  )
    return 'unknown';
  const normalise = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (
    claims.some(item => item.status === 'unresolved') ||
    prior.some(item => current.some(finding => normalise(finding.description) === normalise(item.description)))
  )
    return 'stalled';
  return 'progress';
}

/** Journal a controller decision in its caller's state transaction, linked to the work and budget. */
export function recordRepairDecision(
  { store, id, state }: SettleContext,
  decision: {
    source: 'validation' | 'verification' | 'review';
    action: 'repair' | 'arbitration' | 'stop';
    reason: string;
    resultId: string;
    progress: keyof typeof progressDescriptions;
  },
): void {
  store.append(id, state.version, 'guided.repair_decided', {
    ...decision,
    sliceIndex: state.sliceIndex,
    executionId: state.executionId,
    reviewId: state.reviewId,
    artifact: state.snapshot?.artifact ?? null,
    used: state.repairCycle.used,
    allowance: state.plan.workflowPolicy.repairRounds,
    reasonCode: decision.action === 'repair' ? null : decision.reason,
    note: `${decision.source === 'verification' ? 'Acceptance' : decision.source === 'review' ? 'Review' : 'Validation'}: ${decision.action}. Shared repairs used before this decision: ${state.repairCycle.used}/${state.plan.workflowPolicy.repairRounds}. Progress: ${progressDescriptions[decision.progress]}.`,
  });
}
