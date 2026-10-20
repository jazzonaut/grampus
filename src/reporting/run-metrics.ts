// Owns subscription-focused scorecards derived only from durable controller and provider records.
// Durations describe observed intervals, and never claim to measure attention or subscription quota.
import type { Store } from '../persistence/store.js';
import { z } from 'zod';
import { taskUsage, taskTurnUsage, type TurnUsage, type UsageField } from './task-usage.js';
import { subscriptionMetrics } from './subscription-metrics.js';
import { usageView } from '../server/view-model/usage.js';

/** A model's observed use in one role, including incomplete and failed turns. */
export interface ModelMetrics {
  provider: string;
  stage: string;
  model: string | null;
  requestedModel: string | null;
  effort: string | null;
  turns: number;
  wallMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  estimatedCostUsd: number | null;
  incomplete: UsageField[];
}

function sum(rows: TurnUsage[], field: UsageField): number | null {
  const values = rows.flatMap(row => (row[field] === null ? [] : [row[field]]));
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function models(turns: TurnUsage[]): ModelMetrics[] {
  const groups = new Map<string, TurnUsage[]>();
  for (const turn of turns) {
    const key = JSON.stringify([turn.provider, turn.stage, turn.requestedModel, turn.model, turn.effort]);
    groups.set(key, [...(groups.get(key) ?? []), turn]);
  }
  return [...groups.values()].flatMap(rows => {
    const first = rows[0];
    if (!first) return [];
    const measured = rows.flatMap(row => (row.wallMs === null ? [] : [row.wallMs]));
    return [
      {
        provider: first.provider,
        stage: first.stage,
        model: first.model,
        requestedModel: first.requestedModel,
        effort: first.effort,
        turns: rows.length,
        wallMs: measured.length ? measured.reduce((a, b) => a + b, 0) : null,
        inputTokens: sum(rows, 'inputTokens'),
        outputTokens: sum(rows, 'outputTokens'),
        cachedInputTokens: sum(rows, 'cachedInputTokens'),
        cacheWriteInputTokens: sum(rows, 'cacheWriteInputTokens'),
        estimatedCostUsd: sum(rows, 'estimatedCostUsd'),
        incomplete: [...new Set(rows.flatMap(row => row.incomplete))],
      },
    ];
  });
}

/** One task's scorecard, including partial runs. A verified outcome is the controller's completion. */
export function runMetrics(store: Store, taskId: string) {
  const task = store.get(taskId);
  const events = store.events(taskId);
  const turns = taskTurnUsage(store, taskId);
  const usage = usageView(taskUsage(store, taskId));
  const startedAt = events.find(event => event.type === 'guided.step_requested')?.at ?? turns[0]?.requestedAt ?? null;
  const completedAt = completionTime(task.guided?.status, events);
  const times = turns.flatMap(turn => (turn.wallMs === null ? [] : [turn.wallMs]));
  const checks = store
    .executions()
    .filter(item => item.taskId === taskId)
    .flatMap(item => store.checks(item.id));
  return {
    taskId,
    title: task.brief.title,
    status: task.guided?.status ?? task.phase,
    verifiedDelivery: task.guided?.status === 'complete' && task.phase === 'complete',
    profile: task.guided?.plan.modelProfile ?? null,
    startedAt,
    completedAt,
    elapsedMs: startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null,
    agentMs: times.length ? times.reduce((a, b) => a + b, 0) : null,
    agentTimePartial: turns.some(turn => turn.wallMs === null),
    ...workflowTimes(events, startedAt),
    checkMs: checks.some(check => check.result?.elapsedMs !== undefined)
      ? checks.reduce((total, check) => total + (check.result?.elapsedMs ?? 0), 0)
      : null,
    checkTimePartial: checks.some(check => check.result?.elapsedMs === undefined),
    firstAttemptDelivery: task.guided?.status === 'complete' ? usage.repairAttempts === 0 : null,
    repairAttempts: usage.repairAttempts,
    interventions: usage.interventions,
    usage,
    models: models(turns),
    subscription: subscriptionMetrics(store, turns),
    subscriptionAllowanceConsumed: null,
    billedCostUsd: null,
    notes: [
      'Token counts do not establish subscription allowance consumed.',
      'Estimated cost is provider-reported, not subscription billing.',
      'Elapsed time includes waits; agent time is request-to-settlement time, not inference latency.',
    ],
  };
}

/** Observed workflow intervals separate execution from settled waits, including waits for a person. */
function workflowTimes(events: ReturnType<Store['events']>, startedAt: string | null) {
  let previous = startedAt,
    status = 'running',
    workflowActiveMs = 0,
    waitingMs = 0;
  for (const event of events) {
    if (!previous || event.at < previous) continue;
    const current = z.object({ status: z.string() }).safeParse(event.data).data?.status;
    if (!current || !event.type.startsWith('guided.')) continue;
    const elapsed = Math.max(0, Date.parse(event.at) - Date.parse(previous));
    if (status === 'running') workflowActiveMs += elapsed;
    else if (status !== 'complete') waitingMs += elapsed;
    previous = event.at;
    status = current;
  }
  return {
    workflowActiveMs: startedAt ? workflowActiveMs : null,
    waitingMs: startedAt ? waitingMs : null,
    timingAsOf: previous,
    timingPartial: status !== 'complete',
  };
}

export type RunMetrics = ReturnType<typeof runMetrics>;

/** Completion time comes from the controller's transition, never from a provider's reply. */
function completionTime(status: string | undefined, events: ReturnType<Store['events']>): string | null {
  if (status !== 'complete') return null;
  return (
    events.findLast(
      event =>
        event.type.startsWith('guided.') &&
        z.object({ status: z.string() }).safeParse(event.data).data?.status === 'complete',
    )?.at ?? null
  );
}
