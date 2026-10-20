// Owns the observed results following a repair decision. Only the next controller-adopted
// implementation's checks, review evidence and verified delivery can describe that repair.
import { z } from 'zod';
import type { JournalEvent } from '../../persistence/store.js';
import type { RepairDecisionV1 } from '../api-types.js';
import { checkOutputLimits, viewModelLimits } from '../../config/limits.js';
import { outputExcerpt } from '../../verification/check-output.js';

const implementation = z.object({
  id: z.string(),
  role: z.literal('implementation'),
  attemptId: z.string(),
  sliceIndex: z.number(),
});
const adopted = z.object({ stage: z.enum(['preparation', 'scope']), executionId: z.string(), sliceIndex: z.number() });
const requested = z.object({
  executionId: z.string(),
  checkId: z.string(),
  spec: z.object({ name: z.string(), artifact: z.string(), preparation: z.unknown().exactOptional() }),
});
const settled = z.object({
  checkId: z.string(),
  phase: z.enum(['passed', 'failed', 'interrupted', 'recovery_required']),
});
const review = z.object({
  id: z.string(),
  kind: z.literal('review'),
  attemptId: z.string(),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  artifact: z.string(),
});
const stopped = z.object({ executionId: z.string(), status: z.string(), note: z.string() });
const delivered = z.object({ attemptId: z.string(), artifact: z.string() });
const nextDecision = z.object({ action: z.enum(['repair', 'stop', 'arbitration']) });
type Binding = z.infer<typeof implementation>;
type Result = RepairDecisionV1['results'][number];

interface Observations {
  checks: Map<string, { name: string; artifact: string }>;
  results: Result[];
  outcome: string;
}

/** Creation alone does not prove that the controller adopted an execution for its pending step. */
function adoptedAttempt(event: JournalEvent, created: Map<string, Binding>, sliceIndex: number): Binding | null {
  if (event.type === 'execution.created') {
    const parsed = implementation.safeParse(event.data);
    if (parsed.success && parsed.data.sliceIndex === sliceIndex) created.set(parsed.data.id, parsed.data);
  }
  if (!['guided.step_finished', 'guided.step_reconciled'].includes(event.type)) return null;
  const parsed = adopted.safeParse(event.data);
  return parsed.success && parsed.data.sliceIndex === sliceIndex
    ? (created.get(parsed.data.executionId) ?? null)
    : null;
}

function checkResult(event: JournalEvent, checks: Observations['checks']): Result | null {
  const parsed = settled.safeParse(event.data);
  const spec = parsed.success ? checks.get(parsed.data.checkId) : undefined;
  return parsed.success && spec ? { name: spec.name, outcome: parsed.data.phase, artifact: spec.artifact } : null;
}

function reviewResult(event: JournalEvent, attemptId: string): Result | null {
  const parsed = review.safeParse(event.data);
  if (!parsed.success || parsed.data.attemptId !== attemptId || parsed.data.id.endsWith(':requested')) return null;
  return { name: 'Independent review', outcome: parsed.data.outcome, artifact: parsed.data.artifact };
}

/** Every displayed result retains its artifact and belongs to the controller's adopted attempt. */
function observe(event: JournalEvent, binding: Binding, state: Observations): void {
  if (event.type === 'check.requested') {
    const parsed = requested.safeParse(event.data);
    if (parsed.success && parsed.data.executionId === binding.id && parsed.data.spec.preparation === undefined)
      state.checks.set(parsed.data.checkId, parsed.data.spec);
  }
  if (event.type === 'check.settled' || event.type === 'check.recovered') {
    const result = checkResult(event, state.checks);
    if (result) {
      state.results.push(result);
      state.outcome = 'Check results recorded below; passing checks alone do not establish completion.';
    }
  }
  if (event.type === 'evidence.recorded') {
    const result = reviewResult(event, binding.attemptId);
    if (result) state.results.push(result);
  }
  if (event.type === 'guided.blocked' || event.type === 'guided.spending_blocked') {
    const parsed = stopped.safeParse(event.data);
    if (parsed.success && parsed.data.executionId === binding.id)
      state.outcome = `Attempt stopped: ${outputExcerpt(parsed.data.note, checkOutputLimits.feedbackCharacters)}`;
  }
}

function deliveredAttempt(event: JournalEvent, attemptId: string): boolean {
  if (event.type !== 'task.completed' && event.type !== 'slice.delivered') return false;
  const parsed = delivered.safeParse(event.data);
  return parsed.success && parsed.data.attemptId === attemptId;
}

/** Results of the next adopted attempt only, ending before another decision, manual retry or delivery. */
export function repairResults(
  events: readonly JournalEvent[],
  decision: JournalEvent,
  sliceIndex: number,
): Pick<RepairDecisionV1, 'results' | 'outcome'> {
  const state: Observations = {
    checks: new Map(),
    results: [],
    outcome: 'No settled result from the next attempt has been recorded.',
  };
  const created = new Map<string, Binding>();
  let binding: Binding | null = null;
  for (const event of events) {
    if (event.sequence <= decision.sequence || event.version !== decision.version) continue;
    if (event.type === 'guided.retry_requested') break;
    if (event.type === 'guided.repair_decided') {
      const next = nextDecision.safeParse(event.data);
      if (next.success) state.outcome = `Next decision: ${next.data.action}. See its trigger for the remaining issue.`;
      break;
    }
    binding ??= adoptedAttempt(event, created, sliceIndex);
    if (!binding) continue;
    observe(event, binding, state);
    if (deliveredAttempt(event, binding.attemptId)) {
      state.outcome = 'The repaired slice was verified and delivered locally.';
      break;
    }
  }
  return { results: state.results.slice(-viewModelLimits.repairResults), outcome: state.outcome };
}
