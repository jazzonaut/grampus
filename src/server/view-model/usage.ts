// Owns the dashboard's usage view: the journal-derived task usage (`reporting/task-usage.ts`) with labels,
// completeness and a one-line headline. Unknown values stay null; a total built from some unknown parts
// is a lower bound and says so.
import type { TaskUsage } from '../../reporting/task-usage.js';
import type { ProviderUsageV1, UsageCompleteness, UsageFieldV1, UsageHeadlineV1, UsageV1 } from '../api-types.js';
import { providerLabel } from './status.js';

const stageLabels: Readonly<Record<UsageV1['stages'][number]['stage'], string>> = {
  planning: 'Planning',
  implementation: 'Implementation',
  quality_pass: 'Quality passes',
  repair: 'Repair',
  review: 'Review',
  arbitration: 'Arbitration',
};

const usageNote =
  'Provider token counts have different meanings. Estimated cost uses provider rates; subscription billing may differ, so billed cost is unknown.';

function providerCompleteness(row: TaskUsage['providers'][number]): UsageCompleteness {
  if (row.activeSessions) return 'live';
  if (!row.observedSessions) return 'none';
  return row.incomplete.length || row.observedSessions < row.sessions ? 'partial' : 'complete';
}

/** The sum of a field across providers: null when none measured it, a lower bound when some did not. */
function total(rows: readonly ProviderUsageV1[], field: UsageFieldV1): { value: number | null; partial: boolean } {
  const known = rows.map(row => row[field]).filter((value): value is number => value !== null);
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    partial: known.length < rows.length || rows.some(row => row.incomplete.includes(field)),
  };
}

/** The headline across providers: input plus output tokens, estimated cost, turns and interventions. */
export function usageHeadline(usage: Pick<UsageV1, 'providers' | 'turns' | 'interventions'>): UsageHeadlineV1 {
  const input = total(usage.providers, 'inputTokens'),
    output = total(usage.providers, 'outputTokens'),
    cost = total(usage.providers, 'estimatedCostUsd');
  const tokens = input.value === null && output.value === null ? null : (input.value ?? 0) + (output.value ?? 0);
  const partial = input.partial || output.partial || input.value === null || output.value === null;
  const completeness: UsageCompleteness = !usage.providers.length
    ? 'none'
    : usage.providers.some(row => row.completeness === 'live')
      ? 'live'
      : tokens === null
        ? 'none'
        : partial
          ? 'partial'
          : 'complete';
  return {
    tokens,
    estimatedCostUsd: cost.value,
    completeness,
    turns: usage.turns,
    interventions: usage.interventions.total,
  };
}

/** A task's usage for the dashboard. */
export function usageView(usage: TaskUsage): UsageV1 {
  const providers: ProviderUsageV1[] = usage.providers.map(row => ({
    provider: row.provider,
    label: providerLabel(row.provider),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    incomplete: [...row.incomplete],
    sessions: row.sessions,
    observedSessions: row.observedSessions,
    activeSessions: row.activeSessions,
    updatedAt: row.updatedAt,
    completeness: providerCompleteness(row),
    billedCostUsd: null,
  }));
  const view = {
    providers,
    stages: usage.stages.map(row => ({
      stage: row.stage,
      label: stageLabels[row.stage],
      provider: row.provider,
      providerLabel: providerLabel(row.provider),
      turns: row.turns,
      failedTurns: row.failedTurns,
      interruptedTurns: row.interruptedTurns,
      unsettledTurns: row.unsettledTurns,
      wallMs: row.wallMs,
      wallPartial: row.wallPartial,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteInputTokens: row.cacheWriteInputTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      incomplete: [...row.incomplete],
    })),
    turns: usage.turns,
    failedTurns: usage.failedTurns,
    interruptedTurns: usage.interruptedTurns,
    unsettledTurns: usage.unsettledTurns,
    repairAttempts: usage.repairAttempts,
    interventions: { ...usage.interventions },
    note: usageNote,
  };
  return { headline: usageHeadline(view), ...view };
}
