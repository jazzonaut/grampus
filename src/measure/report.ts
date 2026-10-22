// A task's scorecard: per-dispatch models, time and tokens, totals, and the human cost (decisions made
// and time spent waiting for the user). Built from recorded events, so it is reproducible.
import type { StoredEvent } from '../domain/events.js';
import type { TaskState } from '../pipeline/state.js';
import type { Usage } from './transcripts.js';
import type { DispatchMeasurement } from './usage.js';

export interface Scorecard {
  taskId: string;
  title: string;
  recipe: string;
  outcome: string;
  /** False while the task runs: later turns may still add to the figures. */
  final: boolean;
  dispatches: DispatchMeasurement[];
  totals: { agentMs: number; usage: Usage | null; dispatchesWithUnknownUsage: number };
  rounds: number;
  wallMs: number | null;
  /** Decisions (approve, revise, continue, accept...), answers to worker questions, and time tasks waited for both. */
  human: { decisions: number; answers: number; waitingMs: number; fromChat: number };
}

export function buildScorecard(
  state: TaskState,
  events: readonly StoredEvent[],
  dispatches: DispatchMeasurement[],
): Scorecard {
  const known = dispatches.filter(item => item.usage);
  const sum = (pick: (usage: Usage) => number) =>
    known.reduce((total, item) => total + (item.usage ? pick(item.usage) : 0), 0);
  const created = Date.parse(state.createdAt);
  return {
    taskId: state.taskId,
    title: state.title,
    recipe: state.recipe.name,
    outcome: state.finished ? `${state.finished.outcome}${state.finished.override ? ' (override)' : ''}` : 'running',
    final: Boolean(state.finished && state.measurements),
    dispatches,
    totals: {
      agentMs: dispatches.reduce((total, item) => total + (item.agentMs ?? item.durationMs ?? 0), 0),
      // Partial totals are still shown, with the count of dispatches they miss.
      usage: known.length
        ? {
            input: sum(usage => usage.input),
            cachedInput: sum(usage => usage.cachedInput),
            cacheWrite: sum(usage => usage.cacheWrite),
            output: sum(usage => usage.output),
            reasoning: sum(usage => usage.reasoning ?? 0),
          }
        : null,
      dispatchesWithUnknownUsage: dispatches.length - known.length,
    },
    rounds: state.decisions.size,
    wallMs: state.finished ? Date.parse(state.finished.at) - created : null,
    human: humanCost(events),
  };
}

/** Decisions the user made and how long tasks waited for them, from attention to the deciding command. */
function humanCost(events: readonly StoredEvent[]): Scorecard['human'] {
  let decisions = 0;
  let answers = 0;
  let waitingMs = 0;
  let fromChat = 0;
  let since: number | null = null;
  const asked = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'attention.needed') since = Date.parse(event.at);
    if (event.type === 'worker.message' && event.kind === 'question') asked.set(event.messageId, Date.parse(event.at));
    if (event.type !== 'command.applied') continue;
    if (event.command.kind === 'reply') {
      answers++;
      if (event.command.source === 'chat') fromChat++;
      const question = asked.get(event.command.messageId);
      if (question !== undefined) waitingMs += Date.parse(event.at) - question;
      continue;
    }
    decisions++;
    if (event.command.source === 'chat') fromChat++;
    if (since !== null) waitingMs += Date.parse(event.at) - since;
    since = null;
  }
  return { decisions, answers, waitingMs, fromChat };
}

const number = (value: number | null | undefined) =>
  value === null || value === undefined ? '?' : value.toLocaleString('en-GB');
const seconds = (ms: number | null) => (ms === null ? '?' : `${Math.round(ms / 1000)}s`);

export function renderScorecard(card: Scorecard): string {
  const header = [
    'stage',
    'agent',
    'model',
    'effort',
    'working',
    'waited',
    'input',
    'cached',
    'cache write',
    'output',
    'outcome',
  ];
  const rows = card.dispatches.map(item => [
    item.key,
    item.provider ?? item.agent ?? '?',
    item.models.join(',') || '?',
    item.effort ?? '-',
    seconds(item.agentMs ?? item.durationMs),
    item.waitingMs ? seconds(item.waitingMs) : '-',
    number(item.usage?.input),
    number(item.usage?.cachedInput),
    number(item.usage?.cacheWrite),
    number(item.usage?.output),
    item.outcome ?? 'unsettled',
  ]);
  const usage = card.totals.usage;
  rows.push([
    'total',
    '',
    '',
    '',
    seconds(card.totals.agentMs),
    '',
    number(usage?.input),
    number(usage?.cachedInput),
    number(usage?.cacheWrite),
    number(usage?.output),
    '',
  ]);
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map(row => (row[column] ?? '').length)));
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  const notes = card.dispatches.filter(item => item.note).map(item => `  ${item.key}: ${item.note}`);
  return [
    `${card.taskId}  ${card.title}  (${card.outcome}, recipe ${card.recipe}${card.final ? '' : ', provisional'})`,
    line(header),
    ...rows.map(line),
    `rounds ${card.rounds}; wall time ${seconds(card.wallMs)}; human: ${card.human.decisions} decisions and ${card.human.answers} answers (${card.human.fromChat} from chat), tasks waited ${seconds(card.human.waitingMs)} for them`,
    ...(card.totals.dispatchesWithUnknownUsage
      ? [`usage unknown for ${card.totals.dispatchesWithUnknownUsage} dispatches:`, ...notes]
      : []),
  ].join('\n');
}
