// Delivery metrics distinguish engineering completion from selection waits and external rescue.
import type { StoredEvent } from '../domain/events.js';
import type { TaskState } from '../pipeline/state.js';
import { deliveryLimits } from '../config/limits.js';

export interface DeliveryMeasurement {
  mode: 'supervised' | 'unattended';
  firstVerifiedMs: number | null;
  latestVerifiedMs: number | null;
  selectionWaitMs: number;
  externalInterventions: number;
  automaticRecoveries: number;
  automaticAnswers: number;
  investigations: number;
  modelEscalations: number;
  reopenedAfterReady: number;
  firstPass: boolean | null;
  withinTimeBudget: boolean | null;
  launchMs: number;
}

/** Recorded events determine elapsed time; missing candidates never become zero-time successes. */
export function measureDelivery(state: TaskState, events: readonly StoredEvent[], now: number): DeliveryMeasurement {
  const created = Date.parse(state.createdAt);
  const ready = events.filter(event => event.type === 'round.decided' && event.decision === 'ready');
  const first = ready[0];
  const latest = ready.at(-1);
  const policy = events.filter(event => event.type === 'policy.decided');
  const { selectionWaitMs, reopenedAfterReady } = selectionWait(events, now);
  const latestVerifiedMs = latest ? Date.parse(latest.at) - created : null;
  const decision = events.find(event => event.type === 'round.decided');
  return {
    mode: state.recipe.delivery?.mode ?? 'supervised',
    firstVerifiedMs: first ? Date.parse(first.at) - created : null,
    latestVerifiedMs,
    selectionWaitMs,
    externalInterventions: events.filter(
      event =>
        event.type === 'command.applied' && ['continue', 'revise', 'retry', 'reply'].includes(event.command.kind),
    ).length,
    automaticRecoveries: policy.filter(event => event.action === 'recover').length,
    automaticAnswers: events.filter(event => event.type === 'question.answered').length,
    investigations: policy.filter(event => event.action === 'investigate').length,
    modelEscalations: policy.filter(event => event.action === 'fallback').length,
    reopenedAfterReady,
    firstPass: decision?.type === 'round.decided' ? decision.round === 0 && decision.decision === 'ready' : null,
    withinTimeBudget:
      state.recipe.delivery && latestVerifiedMs !== null
        ? latestVerifiedMs <= state.recipe.delivery.maxSeconds * deliveryLimits.millisecondsPerSecond
        : null,
    launchMs: [...state.stages.values()]
      .flatMap(stage => stage.dispatches)
      .reduce(
        (sum, dispatch) => sum + Math.max(0, Date.parse(dispatch.startedAt) - Date.parse(dispatch.requestedAt)),
        0,
      ),
  };
}

function selectionWait(events: readonly StoredEvent[], now: number) {
  let waiting: number | null = null;
  let selectionWaitMs = 0;
  let reopenedAfterReady = 0;
  for (const event of events) {
    if (event.type === 'attention.needed' && event.reason.startsWith('ready:')) waiting ??= Date.parse(event.at);
    if (
      (event.type === 'command.applied' && ['continue', 'accept', 'decline', 'abandon'].includes(event.command.kind)) ||
      event.type === 'attention.withdrawn' ||
      event.type === 'task.finished'
    ) {
      if (waiting !== null) {
        selectionWaitMs += Math.max(0, Date.parse(event.at) - waiting);
        if (event.type === 'command.applied' && event.command.kind === 'continue') reopenedAfterReady++;
      }
      waiting = null;
    }
  }
  if (waiting !== null) selectionWaitMs += Math.max(0, now - waiting);
  return { selectionWaitMs, reopenedAfterReady };
}
