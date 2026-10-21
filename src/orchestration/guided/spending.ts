// Owns task-wide dispatch allowances. Counts come from the durable usage ledger, never an attempt
// counter, so restarting, revising, repairing or rotating conversations cannot replenish them.
import type { WorkflowPolicy } from '../../domain/workflow-policy.js';
import type { Store } from '../../persistence/store.js';
import { taskSpendingUsage, type TaskUsage, type UsageField } from '../../reporting/task-usage.js';
import type { GuidedState } from './state.js';
import type { StopReasonCode } from './stop-reasons.js';

/** A dispatch threshold, not a prediction or a cap on an already running provider turn. */
export interface SpendingSnapshot {
  turns: number;
  maxTurns: number;
  remainingTurns: number;
  tokens: number | null;
  maxTokens: number;
  remainingTokens: number | null;
  tokenCompleteness: 'complete' | 'partial' | 'unknown';
  status: 'available' | 'turn_limit' | 'token_limit' | 'usage_unknown';
  explanation: string;
}

/**
 * Codex input includes cache reads. Claude reports reads and writes separately, so include them once.
 * Missing, partial or unsettled measurements cannot establish headroom for another paid turn.
 */
function measuredTokens(usage: TaskUsage): Pick<SpendingSnapshot, 'tokens' | 'tokenCompleteness'> {
  if (!usage.turns) return { tokens: 0, tokenCompleteness: 'complete' };
  let tokens = 0,
    known = false,
    complete = usage.unsettledTurns === 0 && usage.providers.length > 0;
  for (const row of usage.providers) {
    const fields: UsageField[] = ['inputTokens', 'outputTokens'];
    if (row.provider === 'claude') fields.push('cachedInputTokens', 'cacheWriteInputTokens');
    for (const field of fields) {
      const value = row[field];
      if (value !== null && Number.isSafeInteger(value) && value >= 0) {
        tokens += value;
        known = true;
      } else complete = false;
      if (row.incomplete.includes(field)) complete = false;
    }
  }
  if (!Number.isSafeInteger(tokens)) return { tokens: null, tokenCompleteness: 'unknown' };
  return { tokens: known ? tokens : null, tokenCompleteness: complete ? 'complete' : known ? 'partial' : 'unknown' };
}

/** Computes the same allowance for the dispatch gate, dashboard, CLI and journal evidence. */
export function spendingStatus(usage: TaskUsage, policy: WorkflowPolicy): SpendingSnapshot {
  const measured = measuredTokens(usage);
  const status: SpendingSnapshot['status'] =
    usage.turns >= policy.maxTaskTurns
      ? 'turn_limit'
      : policy.maxTaskTokens > 0 && measured.tokens !== null && measured.tokens >= policy.maxTaskTokens
        ? 'token_limit'
        : policy.maxTaskTokens > 0 && measured.tokenCompleteness !== 'complete'
          ? 'usage_unknown'
          : 'available';
  const explanations: Readonly<Record<SpendingSnapshot['status'], string>> = {
    available:
      'Allowance remains for another agent turn. Active turns finish normally and may exceed the token threshold. Checks and verified delivery do not spend turns.',
    turn_limit:
      'The approved task-wide turn allowance is exhausted. Revise the plan and approve a higher total before another agent turn.',
    token_limit:
      'The observed task-wide tokens reached the approved threshold. Revise the plan and approve a higher total before another agent turn.',
    usage_unknown:
      'Token usage is missing, partial or unsettled, so remaining allowance cannot be established. Inspect usage, then revise and approve a different token policy if appropriate.',
  };
  return {
    turns: usage.turns,
    maxTurns: policy.maxTaskTurns,
    remainingTurns: Math.max(0, policy.maxTaskTurns - usage.turns),
    ...measured,
    maxTokens: policy.maxTaskTokens,
    remainingTokens:
      policy.maxTaskTokens > 0 && measured.tokens !== null && measured.tokenCompleteness === 'complete'
        ? Math.max(0, policy.maxTaskTokens - measured.tokens)
        : null,
    status,
    explanation: explanations[status],
  };
}

const codes = {
  turn_limit: 'TASK_TURN_LIMIT',
  token_limit: 'TASK_TOKEN_LIMIT',
  usage_unknown: 'TASK_USAGE_UNKNOWN',
} as const satisfies Record<Exclude<SpendingSnapshot['status'], 'available'>, StopReasonCode>;

/** Refuses only agent stages; settlement, checks, recovery and already verified delivery remain possible. */
export function spendingStop(store: Store, id: string, state: GuidedState) {
  if (!['implementation', 'quality_pass', 'review'].includes(state.stage)) return null;
  // Runs before every agent step under the write lock, so it reads sessions, never the task journal.
  const spending = spendingStatus(taskSpendingUsage(store, id), state.plan.workflowPolicy);
  return spending.status === 'available'
    ? null
    : {
        reason: { code: codes[spending.status], note: spending.explanation },
        spending,
      };
}

/** All budget stops require a revised policy and fresh approval, never an automatic retry. */
export function isSpendingStop(code: StopReasonCode | undefined | null): boolean {
  return code === 'TASK_TURN_LIMIT' || code === 'TASK_TOKEN_LIMIT' || code === 'TASK_USAGE_UNKNOWN';
}

/** Plain text used by task-show and Markdown reports, including unknown measurement coverage. */
export function spendingLines(spending: SpendingSnapshot): string[] {
  return [
    `Task-wide turns: ${spending.turns}/${spending.maxTurns}; ${spending.remainingTurns} remaining, including linked planning and all versions.`,
    `Task-wide tokens: ${spending.tokens ?? 'unknown'} (${spending.tokenCompleteness}); threshold ${spending.maxTokens || 'disabled'}.`,
    spending.explanation,
  ];
}
