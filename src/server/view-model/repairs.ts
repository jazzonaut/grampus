// Owns human-readable repair decisions. These explain recorded controller choices, not model intent.
import { z } from 'zod';
import { viewModelLimits } from '../../config/limits.js';
import type { JournalEvent } from '../../persistence/store.js';
import type { GuidedState } from '../../orchestration/guided/state.js';
import type { RepairDecisionV1, RepairsV1 } from '../api-types.js';
import { stopPresentation } from './status.js';
import { repairResults } from './repair-results.js';

const decisionSchema = z.object({
  source: z.enum(['readiness', 'validation', 'verification', 'review']),
  action: z.enum(['repair', 'arbitration', 'stop']),
  reason: z.string(),
  progress: z.enum(['initial', 'artifact_changed', 'progress', 'stalled', 'unknown', 'ineligible']),
  sliceIndex: z.number(),
  used: z.number(),
  allowance: z.number(),
  resultId: z.string(),
  trigger: z.string(),
  artifact: z.string().nullable(),
});

const progress = {
  initial: 'This is the first observed failure.',
  artifact_changed: 'File content changed since the preceding failure; correctness still needs checking.',
  progress: 'The reviewer reports that earlier blockers were resolved, with evidence. This is an agent assessment.',
  stalled: 'No progress was established. Unrelated file changes do not resolve an existing blocker.',
  unknown: 'The review did not establish whether earlier blockers were resolved.',
  ineligible: 'This failure is not eligible for automatic repair.',
} as const;
const sources = {
  readiness: 'Readiness',
  validation: 'Validation',
  verification: 'Acceptance',
  review: 'Independent review',
} as const;
const actions = {
  repair: 'Automatic repair',
  arbitration: 'Fresh arbitration',
  stop: 'Stopped for your decision',
} as const;

/** One recorded decision, or null for another event or a malformed record. */
export function repairDecision(event: JournalEvent): RepairDecisionV1 | null {
  if (event.type !== 'guided.repair_decided') return null;
  const parsed = decisionSchema.safeParse(event.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const reason = Object.entries(stopPresentation).find(([code]) => code === data.reason)?.[1].why;
  const remaining = Math.max(0, data.allowance - data.used - (data.action === 'repair' ? 1 : 0));
  return {
    sequence: event.sequence,
    at: event.at,
    title: `${sources[data.source]}: ${actions[data.action]}`,
    trigger: data.trigger,
    reason:
      reason ??
      (data.reason === 'CHECK_FAILED'
        ? `The check failed on the current change. A repair is allowed within the approved ${data.source === 'readiness' ? 'readiness' : 'shared behavioural'} allowance.`
        : `Controller reason: ${data.reason}`),
    progress: progress[data.progress],
    budget: `${data.source === 'readiness' ? 'Readiness' : 'Shared behavioural'}: ${data.used} of ${data.allowance} repair rounds allocated before this decision; ${remaining} remaining afterwards.`,
    resultId: data.resultId,
    artifact: data.artifact,
    results: [],
    outcome:
      data.action === 'stop'
        ? 'Stopped for your decision.'
        : 'No settled result from the next attempt has been recorded.',
  };
}

/** Current shared budget and the latest decisions of this exact version and slice, newest first. */
export function repairsView(events: readonly JournalEvent[], state: GuidedState): RepairsV1 {
  const decisions = events
    .filter(event => event.version === state.version)
    .flatMap(event => {
      const data = decisionSchema.safeParse(event.data);
      const view = data.success && data.data.sliceIndex === state.sliceIndex ? repairDecision(event) : null;
      return view && data.success ? [{ event, view, action: data.data.action, sliceIndex: data.data.sliceIndex }] : [];
    })
    .slice(-viewModelLimits.repairDecisions)
    .map(({ event, view, action, sliceIndex }) => ({
      ...view,
      ...(action === 'repair' ? repairResults(events, event, sliceIndex) : {}),
    }));
  const allowance = state.plan.workflowPolicy.repairRounds;
  return {
    used: state.repairCycle.used,
    allowance,
    remaining: Math.max(0, allowance - state.repairCycle.used),
    readiness: {
      used: state.readinessCycle.used,
      allowance: state.plan.workflowPolicy.readinessRounds,
      remaining: Math.max(0, state.plan.workflowPolicy.readinessRounds - state.readinessCycle.used),
      checks: state.plan.slices[state.sliceIndex]?.readiness.length ?? 0,
    },
    decisions: decisions.reverse(),
  };
}
