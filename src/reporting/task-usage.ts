import type { Store } from '../persistence/store.js';
import { z } from 'zod';
import { numeric, type Provider, type Usage } from '../providers/types.js';
import { usageSchema } from '../providers/reply-schema.js';

// Journal event payloads this module reads. An event that does not match contributes nothing, so a
// missing or malformed usage report leaves usage unknown rather than counting it as zero.
const linkedSession = z.object({ sessionId: z.string() });
const usageEvent = z.object({ data: usageSchema });
const resultEvent = z.object({ result: z.object({ usage: usageSchema }) });

const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'estimatedCostUsd'] as const;
type Field = (typeof fields)[number];
export interface ProviderUsage {
  provider: Provider;
  sessions: number;
  observedSessions: number;
  activeSessions: number;
  updatedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  incomplete: Field[];
  billedCostUsd: null;
}

/** Cumulative snapshots replace earlier snapshots; independent provider sessions are summed once. */
export function taskUsage(store: Store, taskId: string): ProviderUsage[] {
  const ids = new Set(
    store
      .executions()
      .filter(item => item.taskId === taskId)
      .map(item => item.sessionId),
  );
  const link = (data: unknown) => {
    const linked = linkedSession.safeParse(data);
    if (linked.success) ids.add(linked.data.sessionId);
  };
  for (const event of store.events(taskId, ['guided.kickoff_linked'])) link(event.data);
  for (const id of ids) for (const event of store.sessionEvents(id, ['kickoff.title_started'])) link(event.data);
  const latest = new Map<
    string,
    {
      provider: Provider;
      usage: Usage | null;
      sequence: number;
      covered: boolean;
      active: boolean;
      updatedAt: string | null;
    }
  >();
  for (const id of ids) {
    const session = store.session(id),
      events = store.sessionEvents(id, ['turn.requested', 'usage.updated', 'turn.result']);
    const request = events.findLast(event => event.type === 'turn.requested');
    if (!request) continue;
    let usage: Usage | null = null,
      sequence = 0,
      updatedAt: string | null = null;
    for (const event of events) {
      const value =
        event.type === 'usage.updated'
          ? usageEvent.safeParse(event.data).data?.data
          : event.type === 'turn.result'
            ? resultEvent.safeParse(event.data).data?.result.usage
            : undefined;
      if (value) {
        usage = value;
        sequence = event.sequence;
        updatedAt = event.at;
      }
    }
    const key = `${session.provider}:${session.providerSessionId ?? `local:${session.id}`}`;
    const previous = latest.get(key);
    if (!previous || Math.max(sequence, request.sequence) > previous.sequence)
      latest.set(key, {
        provider: session.provider,
        usage: usage ?? previous?.usage ?? null,
        sequence: Math.max(sequence, request.sequence),
        covered: sequence > request.sequence && usage?.complete !== false,
        active: session.phase === 'running' || session.phase === 'stop_requested',
        updatedAt: updatedAt ?? previous?.updatedAt ?? null,
      });
  }
  return (['codex', 'claude'] as const).flatMap(provider => {
    const rows = [...latest.values()].filter(item => item.provider === provider);
    if (!rows.length) return [];
    const result: ProviderUsage = {
      provider,
      sessions: rows.length,
      observedSessions: rows.filter(item => item.usage).length,
      activeSessions: rows.filter(item => item.active).length,
      updatedAt:
        rows
          .map(item => item.updatedAt)
          .filter((at): at is string => at !== null)
          .sort()
          .at(-1) ?? null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      estimatedCostUsd: null,
      incomplete: [],
      billedCostUsd: null,
    };
    for (const field of fields) {
      const known = rows.map(item => numeric(item.usage?.[field])).filter((value): value is number => value !== null);
      result[field] = known.length ? known.reduce((total, value) => total + value, 0) : null;
      if (known.length !== rows.length || rows.some(item => !item.covered)) result.incomplete.push(field);
    }
    return [result];
  });
}

export function usageLines(rows: ProviderUsage[]): string[] {
  if (!rows.length) return ['Usage and billed cost: unknown (no linked provider usage observations).'];
  return rows.map(row => {
    const value = (field: Field) =>
      row[field] === null
        ? 'unknown'
        : `${field === 'estimatedCostUsd' ? row[field].toFixed(4) : row[field]}${row.incomplete.includes(field) ? ' (partial)' : ''}`;
    return `${row.provider}: input tokens ${value('inputTokens')}; output tokens ${value('outputTokens')}; cached input ${value('cachedInputTokens')}; estimated USD ${value('estimatedCostUsd')}; billed cost unknown. ${row.observedSessions}/${row.sessions} provider sessions have usage observations.`;
  });
}
