// Per-dispatch measurements: the model that actually ran, effort, tokens and time. Orca names each
// dispatch's provider session; the provider transcript supplies the rest. A conversation continued by a
// later dispatch is split at the time that dispatch was requested, so each one is counted once.
import { currentSettings, type Settings } from '../config/settings.js';
import type { Stage } from '../domain/events.js';
import type { Orca } from '../orca/client.js';
import type { TaskState } from '../pipeline/state.js';
import {
  findClaudeTranscript,
  findCodexTranscript,
  readClaudeTranscript,
  readCodexTranscript,
  type TranscriptReading,
  type Usage,
} from './transcripts.js';

export interface DispatchMeasurement {
  key: string;
  stage: Stage;
  round: number;
  dispatchId: string;
  /** The agent Grampus asked for; null when the dispatch continued an earlier conversation. */
  agent: string | null;
  provider: string | null;
  sessionIds: string[];
  models: string[];
  effort: string | null;
  usage: Usage | null;
  /** From the start request to the worker's report; null when it never reported. */
  durationMs: number | null;
  /** Part of the duration spent waiting for the user to answer this worker's questions. */
  waitingMs: number | null;
  /** Duration minus waiting: the time the worker was actually working. */
  agentMs: number | null;
  outcome: 'succeeded' | 'failed' | null;
  /** Why something is unknown. */
  note: string | null;
}

interface Located {
  measurement: DispatchMeasurement;
  from: number;
}

/** Measure every dispatch of a task. Unknown values stay null with a note; nothing becomes zero. */
export async function measureDispatches(
  state: TaskState,
  orca: Pick<Orca, 'transcriptSessions'>,
  settings: Settings = currentSettings(),
): Promise<DispatchMeasurement[]> {
  const located: Located[] = [];
  for (const record of state.stages.values())
    for (const dispatch of record.dispatches) {
      const from = Date.parse(dispatch.requestedAt);
      const sessions = await orca
        .transcriptSessions(dispatch.dispatchId)
        .catch((error: unknown) => (error as Error).message);
      located.push({
        from,
        measurement: {
          key: record.key,
          stage: record.stage,
          round: record.round,
          dispatchId: dispatch.dispatchId,
          agent: typeof dispatch.launch?.requested?.['agent'] === 'string' ? dispatch.launch.requested['agent'] : null,
          provider: typeof sessions === 'string' ? null : sessions.provider,
          sessionIds: typeof sessions === 'string' ? [] : sessions.sessionIds,
          models: [],
          effort: null,
          usage: null,
          ...timing(state, record.key, from, dispatch.settled ? Date.parse(dispatch.settled.at) : null),
          outcome: dispatch.settled?.outcome ?? null,
          note: typeof sessions === 'string' ? `transcript unavailable: ${sessions}` : null,
        },
      });
    }
  for (const item of located) readUsage(item, located, settings);
  return located.map(item => item.measurement);
}

/** Duration, the part spent waiting for answers to this dispatch's questions, and the rest. */
function timing(
  state: TaskState,
  key: string,
  from: number,
  to: number | null,
): Pick<DispatchMeasurement, 'durationMs' | 'waitingMs' | 'agentMs'> {
  if (to === null) return { durationMs: null, waitingMs: null, agentMs: null };
  const answers = new Map<string, number>();
  for (const command of state.commands)
    if (command.kind === 'reply') answers.set(command.messageId, Date.parse(command.at));
  let waitingMs = 0;
  for (const [messageId, question] of state.questions) {
    const asked = Date.parse(question.at);
    if (question.key !== key || asked < from || asked > to) continue;
    waitingMs += Math.max(0, Math.min(answers.get(messageId) ?? to, to) - asked);
  }
  return { durationMs: to - from, waitingMs, agentMs: to - from - waitingMs };
}

function readUsage(item: Located, all: readonly Located[], settings: Settings): void {
  const { measurement } = item;
  if (!measurement.sessionIds.length) {
    measurement.note ??= 'no provider session found';
    return;
  }
  const readings: TranscriptReading[] = [];
  for (const sessionId of measurement.sessionIds) {
    // The next dispatch that continued this conversation ends this one's window.
    const next = all
      .filter(other => other !== item && other.measurement.sessionIds.includes(sessionId) && other.from > item.from)
      .map(other => other.from)
      .sort((a, b) => a - b)[0];
    const window = { from: item.from, to: next ?? Number.POSITIVE_INFINITY };
    const reading = readSession(measurement.provider, sessionId, window, settings, new Date(item.from));
    if (reading) readings.push(reading);
  }
  if (!readings.length) {
    measurement.note = `no ${measurement.provider ?? 'provider'} transcript found for ${measurement.sessionIds.join(', ')}`;
    return;
  }
  measurement.models = [...new Set(readings.flatMap(reading => reading.models))];
  measurement.effort = readings.find(reading => reading.effort)?.effort ?? null;
  measurement.usage = sumUsage(readings.map(reading => reading.usage));
  if (!measurement.usage) measurement.note = 'the transcript has no usage in this dispatch window';
}

function readSession(
  provider: string | null,
  sessionId: string,
  window: { from: number; to: number },
  settings: Settings,
  near: Date,
): TranscriptReading | null {
  if (provider === 'claude') {
    const path = findClaudeTranscript(sessionId, settings.claudeProjectRoots);
    return path ? readClaudeTranscript(path, window) : null;
  }
  if (provider === 'codex') {
    const path = findCodexTranscript(sessionId, settings.codexSessionRoots, near);
    return path ? readCodexTranscript(path, window) : null;
  }
  return null;
}

/** Sum known usage; any unknown part makes the whole unknown rather than an undercount. */
function sumUsage(parts: readonly (Usage | null)[]): Usage | null {
  if (!parts.length || parts.some(part => part === null)) return null;
  const known = parts as Usage[];
  const reasoning = known.every(part => part.reasoning === null)
    ? null
    : known.reduce((sum, part) => sum + (part.reasoning ?? 0), 0);
  return {
    input: known.reduce((sum, part) => sum + part.input, 0),
    cachedInput: known.reduce((sum, part) => sum + part.cachedInput, 0),
    cacheWrite: known.reduce((sum, part) => sum + part.cacheWrite, 0),
    output: known.reduce((sum, part) => sum + part.output, 0),
    reasoning,
  };
}
