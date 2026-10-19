// Owns guidance presentation. Assignment to a durable dispatch intent is never described as proof
// that a provider received, followed or accepted a message.
import { z } from 'zod';
import { guidanceLimits } from '../../config/limits.js';
import {
  guidanceMessageSchema,
  type GuidanceMessage,
  type GuidanceTarget,
} from '../../orchestration/guided/guidance.js';
import type { GuidedState } from '../../orchestration/guided/state.js';
import type { JournalEvent } from '../../persistence/store.js';
import type { ActionView, GuidanceMessageV1, GuidanceV1 } from '../api-types.js';
import { action, field, option } from './actions.js';

const targetLabels: Readonly<Record<GuidanceTarget, string>> = {
  next_agent: 'Next agent turn',
  implementer: 'Implementer or edit pass',
  reviewer: 'Independent review or arbitration',
};
const queued = z.object({ message: guidanceMessageSchema });
const cancelled = z.object({ messageId: z.string() });
const assigned = z.object({ pending: z.object({ stage: z.string(), guidance: z.array(guidanceMessageSchema) }) });
const restored = z.object({ restoredGuidance: z.array(z.string()) });

/** Server-owned form; its request carries the current decision key while its draft survives progress. */
function compose(id: string, state: GuidedState, expected: string, starting: boolean): ActionView {
  const full = state.guidance.length + (state.pending?.guidance.length ?? 0) >= guidanceLimits.pendingMessages;
  return action({
    id: 'queue-guidance',
    label: 'Queue guidance',
    kind: 'secondary',
    description: 'Adds guidance for a future agent turn. It does not interrupt work, start a turn or change approval.',
    path: `/api/tasks/${id}/guidance`,
    expected,
    disabledReason: starting
      ? 'Wait for the worker to claim the task.'
      : state.stage === 'delivery' && state.pending
        ? 'Local delivery has already started.'
        : full
          ? `At most ${guidanceLimits.pendingMessages} messages may be queued or assigned to the active step.`
          : null,
    form: {
      kind: 'message',
      intro:
        'Refine the approach within the approved plan. Use plan revision for scope, commands, requirements or acceptance changes. Guidance does not answer pending structured questions.',
      fields: [
        field({
          name: 'text',
          label: 'Your guidance',
          input: 'textarea',
          value: '',
          required: true,
          help: `At most ${guidanceLimits.messageBytes} UTF-8 bytes. This waits for a matching turn; it cannot alter the current one.`,
          target: '/text',
        }),
        field({
          name: 'target',
          label: 'Send to',
          input: 'select',
          value: 'next_agent',
          required: true,
          options: Object.entries(targetLabels).map(([value, label]) => option(value, label)),
          target: '/target',
        }),
      ],
      submitLabel: 'Queue guidance',
    },
  });
}

function messageStatus(
  message: GuidanceMessage,
  state: GuidedState,
  assignments: Map<string, string>,
  cancellations: Set<string>,
) {
  if (state.guidance.some(item => item.id === message.id))
    return {
      status: 'queued' as const,
      statusLabel: 'Queued',
      detail: 'Waiting for the next matching agent step. No turn was started by this message.',
    };
  if (cancellations.has(message.id))
    return { status: 'cancelled' as const, statusLabel: 'Cancelled', detail: 'Withdrawn before assignment to a turn.' };
  const stage = assignments.get(message.id);
  if (stage)
    return {
      status: 'assigned' as const,
      statusLabel: 'Assigned to a step',
      detail: `Assigned to the ${stage} request. This does not confirm the provider received or followed it; inspect the resulting work.`,
    };
  if (message.version !== state.version || message.sliceIndex !== state.sliceIndex)
    return {
      status: 'expired' as const,
      statusLabel: 'Expired',
      detail: 'The plan version or slice changed before this message was assigned.',
    };
  return {
    status: 'unknown' as const,
    statusLabel: 'Assignment unconfirmed',
    detail: 'No assignment or cancellation can be established. Inspect saved work before resubmitting.',
  };
}

/** Reads current authoritative queue state and bounded recent journal history. */
export function guidanceView(
  id: string,
  state: GuidedState,
  events: readonly JournalEvent[],
  expected: string,
  approved: boolean,
  starting: boolean,
): GuidanceV1 {
  const messages = new Map<string, GuidanceMessage>(),
    assignments = new Map<string, string>(),
    cancellations = new Set<string>();
  for (const event of events) {
    if (event.type === 'guided.guidance_queued') {
      const data = queued.safeParse(event.data).data;
      if (data) messages.set(data.message.id, data.message);
    }
    if (event.type === 'guided.guidance_cancelled') {
      const data = cancelled.safeParse(event.data).data;
      if (data) cancellations.add(data.messageId);
    }
    if (event.type === 'guided.step_requested') {
      const data = assigned.safeParse(event.data).data;
      if (data) for (const message of data.pending.guidance) assignments.set(message.id, data.pending.stage);
    }
    if (event.type === 'guided.step_reconciled' || event.type === 'guided.step_failed') {
      const data = restored.safeParse(event.data).data;
      if (data) for (const id of data.restoredGuidance) assignments.delete(id);
    }
  }
  const active = [...state.guidance, ...(state.pending?.guidance ?? [])];
  if (state.pending) for (const message of state.pending.guidance) assignments.set(message.id, state.pending.stage);
  for (const message of active) messages.set(message.id, message);
  const activeIds = new Set(active.map(message => message.id));
  const recent = [...messages.values()]
    .filter(message => !activeIds.has(message.id))
    .slice(-guidanceLimits.historyMessages);
  const rows: GuidanceMessageV1[] = [...recent, ...active].map(message => {
    const status = messageStatus(message, state, assignments, cancellations);
    return {
      id: message.id,
      text: message.text,
      at: message.at,
      version: message.version,
      slice: message.sliceIndex + 1,
      targetLabel: targetLabels[message.target],
      ...status,
      cancel:
        status.status === 'queued' && approved
          ? action({
              id: 'cancel-guidance',
              label: 'Cancel guidance',
              kind: 'secondary',
              description: 'Withdraws this queued message. An assigned message cannot be cancelled.',
              path: `/api/tasks/${id}/cancel-guidance`,
              expected,
              body: { expected, messageId: message.id },
            })
          : null,
    };
  });
  return {
    draftKey: `${state.version}:${state.digest}:${state.sliceIndex}`,
    compose: approved && state.status !== 'complete' ? compose(id, state, expected, starting) : null,
    messages: rows.sort((a, b) => b.at.localeCompare(a.at)),
  };
}
