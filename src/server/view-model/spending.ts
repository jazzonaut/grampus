// Owns spending labels. The controller's calculation supplies every rule and all measurement coverage.
import type { TaskUsage } from '../../reporting/task-usage.js';
import type { WorkflowPolicy } from '../../domain/workflow-policy.js';
import { spendingStatus } from '../../orchestration/guided/spending.js';
import type { SpendingV1 } from '../api-types.js';

/** The approved totals and observed remaining allowance for the visible task screen. */
export function spendingView(usage: TaskUsage, policy: WorkflowPolicy): SpendingV1 {
  const spending = spendingStatus(usage, policy);
  const labels: Readonly<Record<SpendingV1['status'], string>> = {
    available: 'Allowance remains',
    turn_limit: 'Turn allowance exhausted',
    token_limit: 'Token threshold reached',
    usage_unknown: 'Token allowance unknown',
  };
  const observed =
    spending.tokens === null
      ? 'Unknown'
      : `${spending.tokens.toLocaleString('en-GB')}${spending.tokenCompleteness === 'partial' ? '+' : ''}`;
  return {
    status: spending.status,
    statusLabel: labels[spending.status],
    turnsLabel: `${spending.turns} of ${spending.maxTurns} agent turns used; ${spending.remainingTurns} remaining.`,
    tokensLabel:
      policy.maxTaskTokens > 0
        ? `${observed} of ${policy.maxTaskTokens.toLocaleString('en-GB')} tokens observed; ${spending.remainingTokens === null ? 'remaining unknown' : `${spending.remainingTokens.toLocaleString('en-GB')} remaining`}.`
        : `${observed} tokens observed. Token threshold disabled; the turn allowance still applies.`,
    explanation: spending.explanation,
    note: 'Includes linked planning, implementation, edit passes, repair, review and arbitration across every slice and plan version. Claude cache reads and writes are included; Codex input already includes cache reads. Estimated cost is shown in Usage; no dollar cap is enforced.',
  };
}
