// Owns per-task usage accounting: provider tokens and estimated cost per provider and per workflow
// stage, provider turn counters, wall time per stage and human interventions after approval, all
// derived from the journal. Unknown values stay null and mark totals partial; they never count as zero.
import type { JournalEvent, RecordEvent, Store } from '../persistence/store.js';
import { z } from 'zod';
import { numeric, type Provider, type Usage } from '../providers/types.js';
import { usageSchema } from '../providers/reply-schema.js';
import { turnStageSchema, type TurnStage } from '../persistence/records.js';

// Journal event payloads this module reads. An event that does not match contributes nothing, so a
// missing or malformed usage report leaves usage unknown rather than counting it as zero.
const linkedSession = z.object({ sessionId: z.string() });
const requestEvent = z.object({ stage: turnStageSchema });
const usageEvent = z.object({ data: usageSchema });
const resultEvent = z.object({
  result: z.object({ status: z.enum(['completed', 'interrupted', 'failed']), usage: usageSchema.nullable() }),
});

/** The counters a usage snapshot carries, in display order. */
export const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'estimatedCostUsd',
] as const;
export type UsageField = (typeof usageFields)[number];
type Counters = Record<UsageField, number | null>;

/** Stages in workflow order, as reports and the dashboard list them. */
export const usageStages: readonly TurnStage[] = [
  'planning',
  'implementation',
  'quality_pass',
  'repair',
  'review',
  'arbitration',
];

/** Measured usage of one provider across a task, summed over its provider sessions. */
export interface ProviderUsage extends Counters {
  provider: Provider;
  /** Distinct provider sessions (a resumed conversation counts once). */
  sessions: number;
  /** Provider sessions with at least one usage observation. */
  observedSessions: number;
  /** Provider sessions whose latest turn is still running or stopping. */
  activeSessions: number;
  /** Time of the latest usage observation; null when there is none. */
  updatedAt: string | null;
  /** Fields whose total is a lower bound: some turn's usage is unknown or still incomplete. */
  incomplete: UsageField[];
  /** Always null: the journal records provider estimates, never what was actually billed. */
  billedCostUsd: null;
}

/** Usage, turn counts and wall time of one workflow stage on one provider. */
export interface StageUsage extends Counters {
  stage: TurnStage;
  provider: Provider;
  /** Provider turns requested (`turn.requested`). */
  turns: number;
  failedTurns: number;
  interruptedTurns: number;
  /** Turns without a recorded result: still running, or awaiting recovery. */
  unsettledTurns: number;
  /** Sum of settled turns' time from request to result; null when no turn has settled. */
  wallMs: number | null;
  /** Whether `wallMs` omits unsettled turns. */
  wallPartial: boolean;
  incomplete: UsageField[];
}

/**
 * Human interventions after the first approval, counted from guided journal events: answers to agent
 * questions, scope authorizations, quality assessments, retries (including preparation retries), check
 * reruns, recoveries (including releasing a workspace reservation), plan revisions, stop/pause requests and
 * approvals of revised plans. Continuing a task with `task-run` and low-level CLI commands outside the
 * guided controller are not counted.
 */
export interface Interventions {
  total: number;
  answers: number;
  authorizations: number;
  assessments: number;
  retries: number;
  rerunChecks: number;
  recoveries: number;
  revisions: number;
  stops: number;
  approvals: number;
  guidance: number;
}
type InterventionKind = Exclude<keyof Interventions, 'total'>;

const interventionEvents: Readonly<Partial<Record<string, InterventionKind>>> = {
  'guided.answers_supplied': 'answers',
  'guided.scope_authorized': 'authorizations',
  'guided.assessment_supplied': 'assessments',
  'guided.retry_requested': 'retries',
  'guided.preparation_retry_requested': 'retries',
  'guided.checks_rerun_requested': 'rerunChecks',
  'guided.recovery_requested': 'recoveries',
  'guided.workspace_released': 'recoveries',
  'guided.revised': 'revisions',
  'guided.stop_requested': 'stops',
  'guided.pause_requested': 'stops',
  'guided.guidance_queued': 'guidance',
  'guided.guidance_cancelled': 'guidance',
  'guided.approved': 'approvals',
};

/** Everything measured about a task's provider work. */
export interface TaskUsage {
  providers: ProviderUsage[];
  stages: StageUsage[];
  /** Provider turns across all stages and providers. */
  turns: number;
  failedTurns: number;
  interruptedTurns: number;
  unsettledTurns: number;
  /** Implementation attempts after the first in a slice: automatic repairs and explicit retries. */
  repairAttempts: number;
  interventions: Interventions;
}

/** One provider turn: its stage, timing, outcome and the usage it added to its provider session. */
interface Run {
  key: string;
  provider: Provider;
  stage: TurnStage;
  /** Global journal order of the turn request, across sessions. */
  sequence: number;
  active: boolean;
  requestedAt: string;
  settledAt: string | null;
  status: 'completed' | 'interrupted' | 'failed' | null;
  /** The first observed and the latest field-wise known cumulative values during the turn. */
  first: Counters | null;
  last: Counters | null;
  /** Whether the latest snapshot is final rather than an interim sample. */
  complete: boolean;
  /** Terminal counters only. Retained live values cannot prove a missing final field is complete. */
  final: Counters | null;
  updatedAt: string | null;
  /** Usage this turn added; null fields are unknown. Filled in by `attribute`. */
  delta: Counters;
}

const nulls = (): Counters => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  estimatedCostUsd: null,
});

const counters = (values: (field: UsageField) => number | null): Counters => ({
  inputTokens: values('inputTokens'),
  outputTokens: values('outputTokens'),
  cachedInputTokens: values('cachedInputTokens'),
  cacheWriteInputTokens: values('cacheWriteInputTokens'),
  estimatedCostUsd: values('estimatedCostUsd'),
});

/**
 * Adds one cumulative usage snapshot to a turn. A field the snapshot does not report keeps its last
 * known value, and `complete: false` marks an interim sample that a later snapshot may still raise.
 */
function observe(run: Run, usage: Usage, event: RecordEvent): void {
  const values = counters(field => numeric(usage[field]));
  run.first ??= values;
  const last = run.last ?? nulls();
  run.last = counters(field => values[field] ?? last[field]);
  run.complete = usage.complete !== false;
  run.updatedAt = event.at;
}

/**
 * Turns of one Grampus session. Usage and results belong to the turn requested most recently before them;
 * only the first result of a turn counts. A request without a readable stage is counted as planning.
 */
function sessionRuns(store: Store, sessionId: string): Run[] {
  const session = store.session(sessionId);
  // Keyed by the provider conversation, so Grampus sessions that resume one conversation share its totals.
  const key = `${session.provider}:${session.providerSessionId ?? `local:${session.id}`}`;
  const runs: Run[] = [];
  for (const event of store.sessionEvents(sessionId, ['turn.requested', 'usage.updated', 'turn.result'])) {
    if (event.type === 'turn.requested') {
      runs.push({
        key,
        provider: session.provider,
        stage: requestEvent.safeParse(event.data).data?.stage ?? 'planning',
        sequence: event.sequence,
        active: false,
        requestedAt: event.at,
        settledAt: null,
        status: null,
        first: null,
        last: null,
        complete: false,
        final: null,
        updatedAt: null,
        delta: nulls(),
      });
      continue;
    }
    const run = runs.at(-1);
    if (!run) continue;
    if (event.type === 'usage.updated') {
      const usage = usageEvent.safeParse(event.data).data?.data;
      if (usage) {
        observe(run, usage, event);
        // Recovery may append an explicit final snapshot after an interrupted result.
        if (run.status !== null && usage.complete === true) run.final = counters(field => numeric(usage[field]));
      }
      continue;
    }
    const result = resultEvent.safeParse(event.data).data?.result;
    if (!result || run.status !== null) continue;
    run.status = result.status;
    run.settledAt = event.at;
    const finalUsage = result.usage;
    if (finalUsage) {
      observe(run, finalUsage, event);
      run.final = counters(field => numeric(finalUsage[field]));
    }
    // A last live sample cannot prove final spend when the terminal result has no usage.
    else run.complete = false;
  }
  const current = runs.at(-1);
  if (current && current.status === null && (session.phase === 'running' || session.phase === 'stop_requested'))
    current.active = true;
  return runs;
}

/**
 * Turns each provider session's cumulative snapshots into per-turn usage. Providers report cumulative
 * counters per provider session and a resumed session normally continues them (the pinned Claude Agent
 * SDK and Codex app-server both restore totals on resume; see ARCHITECTURE.md), so a turn adds its
 * latest values minus the session's previous known totals. A turn whose first observation is below
 * the previous total in any field restarted its counters instead (a transcript without saved totals, or
 * a reset), so its own values are its usage. A turn without observations has unknown usage; the next
 * observed turn of that provider session then also carries its spend, which keeps provider totals right.
 */
function attribute(runs: Run[]): void {
  const known = new Map<string, Counters>();
  for (const run of runs) {
    const { first, last } = run;
    if (!first || !last) continue;
    const previous = known.get(run.key);
    const reset =
      !previous ||
      usageFields.some(field => {
        const before = previous[field],
          now = first[field];
        return before !== null && now !== null && now < before;
      });
    run.delta = counters(field => {
      const end = last[field],
        start = reset ? 0 : (previous?.[field] ?? null);
      return end !== null && start !== null ? Math.max(0, end - start) : null;
    });
    known.set(
      run.key,
      counters(field => last[field] ?? previous?.[field] ?? null),
    );
  }
}

/** The sum of the known per-turn values of `field`, or null when no turn measured it. */
function sum(rows: Run[], field: UsageField): number | null {
  const values = rows.map(run => run.delta[field]).filter((value): value is number => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

/**
 * Fields whose total is a lower bound: a turn is still incomplete, or a turn has no measurement of a
 * field that other turns did measure. A field no turn measured is simply unknown (its total is null).
 */
function incompleteFields(rows: Run[]): UsageField[] {
  return usageFields.filter(
    field =>
      rows.some(
        run => !run.complete || (run.delta[field] !== null && (run.final === null || run.final[field] === null)),
      ) ||
      (rows.some(run => run.delta[field] !== null) && rows.some(run => run.delta[field] === null)),
  );
}

/** Counts {@link Interventions} strictly after the first `guided.approved` event; none before approval. */
function interventions(events: JournalEvent[]): Interventions {
  const result: Interventions = {
    total: 0,
    answers: 0,
    authorizations: 0,
    assessments: 0,
    retries: 0,
    rerunChecks: 0,
    recoveries: 0,
    revisions: 0,
    stops: 0,
    approvals: 0,
    guidance: 0,
  };
  const approved = events.find(event => event.type === 'guided.approved');
  if (!approved) return result;
  for (const event of events) {
    const kind = interventionEvents[event.type];
    if (!kind || event.sequence <= approved.sequence) continue;
    result[kind]++;
    result.total++;
  }
  return result;
}

/** The Grampus sessions whose turns count for a task: its executions and its planning conversation. */
function linkedSessions(store: Store, taskId: string): string[] {
  const ids = new Set(
    store
      .executions()
      .filter(item => item.taskId === taskId)
      .map(item => item.sessionId),
  );
  for (const event of store.events(taskId, ['guided.kickoff_linked'])) {
    const linked = linkedSession.safeParse(event.data);
    if (linked.success) ids.add(linked.data.sessionId);
  }
  return [...ids];
}

/**
 * Measured usage of a task. Each provider turn's usage is attributed to the stage recorded when it was
 * requested; provider totals are the sums over turns, so a resumed conversation counts once. Throws as
 * `Store.get` and `Store.session` do when a linked record is missing or malformed.
 */
export function taskUsage(store: Store, taskId: string): TaskUsage {
  return aggregateUsage(
    store,
    linkedSessions(store, taskId),
    store.executions().filter(item => item.taskId === taskId && item.stage === 'repair').length,
    interventions(store.events(taskId)),
  );
}

/** Measured planning usage before or after conversion; the linked task uses the same session ledger. */
export function planningUsage(store: Store, sessionId: string): TaskUsage {
  return aggregateUsage(store, [sessionId], 0, interventions([]));
}

/** Shared attribution prevents conversion from changing the meaning of planning measurements. */
function aggregateUsage(store: Store, sessionIds: string[], repairAttempts: number, human: Interventions): TaskUsage {
  const runs = sessionIds.flatMap(id => sessionRuns(store, id)).sort((a, b) => a.sequence - b.sequence);
  attribute(runs);
  const providers = (['codex', 'claude'] as const).flatMap((provider): ProviderUsage[] => {
    const rows = runs.filter(run => run.provider === provider);
    if (!rows.length) return [];
    const keys = [...new Set(rows.map(run => run.key))];
    return [
      {
        provider,
        sessions: keys.length,
        observedSessions: keys.filter(key => rows.some(run => run.key === key && run.last)).length,
        activeSessions: keys.filter(key => rows.some(run => run.key === key && run.active)).length,
        updatedAt:
          rows
            .map(run => run.updatedAt)
            .filter((at): at is string => at !== null)
            .sort()
            .at(-1) ?? null,
        ...counters(field => sum(rows, field)),
        incomplete: incompleteFields(rows),
        billedCostUsd: null,
      },
    ];
  });
  const stages = usageStages.flatMap(stage =>
    (['codex', 'claude'] as const).flatMap((provider): StageUsage[] => {
      const rows = runs.filter(run => run.stage === stage && run.provider === provider);
      if (!rows.length) return [];
      const settled = rows.flatMap(run => (run.settledAt === null ? [] : [{ run, settledAt: run.settledAt }]));
      return [
        {
          stage,
          provider,
          turns: rows.length,
          failedTurns: rows.filter(run => run.status === 'failed').length,
          interruptedTurns: rows.filter(run => run.status === 'interrupted').length,
          unsettledTurns: rows.length - settled.length,
          wallMs: settled.length
            ? settled.reduce(
                (total, item) => total + Math.max(0, Date.parse(item.settledAt) - Date.parse(item.run.requestedAt)),
                0,
              )
            : null,
          wallPartial: settled.length < rows.length,
          ...counters(field => sum(rows, field)),
          incomplete: incompleteFields(rows),
        },
      ];
    }),
  );
  const count = (key: 'turns' | 'failedTurns' | 'interruptedTurns' | 'unsettledTurns') =>
    stages.reduce((total, row) => total + row[key], 0);
  return {
    providers,
    stages,
    turns: count('turns'),
    failedTurns: count('failedTurns'),
    interruptedTurns: count('interruptedTurns'),
    unsettledTurns: count('unsettledTurns'),
    repairAttempts,
    interventions: human,
  };
}

const fieldLabels: Readonly<Record<UsageField, string>> = {
  inputTokens: 'input tokens',
  outputTokens: 'output tokens',
  cachedInputTokens: 'cache read input',
  cacheWriteInputTokens: 'cache write input',
  estimatedCostUsd: 'estimated USD',
};

/** A measured value as text: `unknown` for null, marked `(partial)` when it is a lower bound. */
export function usageValue(row: Counters & { incomplete: UsageField[] }, field: UsageField): string {
  const value = row[field];
  if (value === null) return 'unknown';
  return `${field === 'estimatedCostUsd' ? value.toFixed(4) : value}${row.incomplete.includes(field) ? ' (partial)' : ''}`;
}

const secondsPerMinute = 60;
const millisecondsPerSecond = 1000;

/** A stage's wall time such as `1 m 05 s`; unknown when no turn has settled. */
export function wallTime(row: Pick<StageUsage, 'wallMs' | 'wallPartial'>): string {
  if (row.wallMs === null) return 'unknown';
  const seconds = Math.round(row.wallMs / millisecondsPerSecond);
  const text =
    seconds < secondsPerMinute
      ? `${seconds} s`
      : `${Math.floor(seconds / secondsPerMinute)} m ${String(seconds % secondsPerMinute).padStart(2, '0')} s`;
  return row.wallPartial ? `${text} (partial)` : text;
}

/** Plain-text usage summary for the CLI and the report header. */
export function usageLines(usage: TaskUsage): string[] {
  if (!usage.providers.length) return ['Usage and billed cost: unknown (no linked provider usage observations).'];
  const human = usage.interventions;
  return [
    ...usage.providers.map(
      row =>
        `${row.provider}: ${usageFields.map(field => `${fieldLabels[field]} ${usageValue(row, field)}`).join('; ')}; billed cost unknown. ${row.observedSessions}/${row.sessions} provider sessions have usage observations.`,
    ),
    `Provider turns: ${usage.turns} (${usage.failedTurns} failed, ${usage.interruptedTurns} interrupted, ${usage.unsettledTurns} unsettled); repair attempts: ${usage.repairAttempts}.`,
    `Human interventions after approval: ${human.total} (answers ${human.answers}, authorizations ${human.authorizations}, assessments ${human.assessments}, retries ${human.retries}, check reruns ${human.rerunChecks}, recoveries ${human.recoveries}, revisions ${human.revisions}, stops ${human.stops}, guidance actions ${human.guidance}, approvals ${human.approvals}).`,
    ...usage.stages.map(
      row =>
        `${row.stage} (${row.provider}): ${row.turns} turns, ${row.failedTurns} failed, ${row.interruptedTurns} interrupted; wall time ${wallTime(row)}; ${usageFields.map(field => `${fieldLabels[field]} ${usageValue(row, field)}`).join('; ')}.`,
    ),
  ];
}

/** Per-stage usage as a Markdown table for the report; every cell is a number or a fixed word. */
export function usageTable(usage: TaskUsage): string[] {
  if (!usage.stages.length) return [];
  return [
    '| Stage | Provider | Turns | Failed | Interrupted | Wall time | Input | Output | Cache read | Cache write | Estimated USD |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...usage.stages.map(
      row =>
        `| ${row.stage} | ${row.provider} | ${row.turns} | ${row.failedTurns} | ${row.interruptedTurns} | ${wallTime(row)} | ${usageFields.map(field => usageValue(row, field)).join(' | ')} |`,
    ),
  ];
}
