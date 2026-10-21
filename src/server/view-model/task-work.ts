// Owns the task's bounded work feed, keeping provider observations separate from controller evidence.
import { serverLimits } from '../../config/limits.js';
import { NativeProgress } from '../../orchestration/native-progress.js';
import type { Session } from '../../persistence/records.js';
import type { Store } from '../../persistence/store.js';
import type { TaskWorkV1 } from '../api-types.js';
import { activityFields, activityPreview } from './activity-events.js';
import { z } from 'zod';

/** The only events the feed reads; prompts and streamed output are never loaded. */
const feedEvents = [
  'turn.requested',
  'turn.result',
  'activity.requested',
  'activity.started',
  'activity.progress',
  'activity.completed',
] as const;
const envelope = z.object({ runId: z.string(), data: z.unknown().optional() });
const completed = z.object({
  exitConfirmed: z.literal(true),
  result: z.object({
    status: z.literal('completed'),
    reply: z.object({ kind: z.string(), text: z.string() }),
  }),
});

/**
 * Reads only the displayed session, fences tool observations to its latest run and redacts messages.
 * The update is the latest completed turn's reply when that reply was a message; a later candidate or
 * question supersedes it, while an interrupted or failed turn leaves it standing.
 */
export function taskWorkView(store: Store, session: Session | null): TaskWorkV1 {
  const work: TaskWorkV1 = { recent: [], update: null };
  if (!session) return work;
  const events = store.sessionEvents(session.id, feedEvents);
  const latest = events.findLast(event => event.type === 'turn.requested');
  const runId = session.run?.id ?? activityFields(latest?.data).runId;
  const native = new NativeProgress();
  const recent = new Map<string, TaskWorkV1['recent'][number]>();
  for (const event of events) {
    if (event.type === 'turn.result') {
      const reply = completed.safeParse(event.data).data?.result.reply;
      if (reply) {
        const text = reply.kind === 'message' ? activityPreview(reply.text) : null;
        work.update = text ? { at: event.at, text } : null;
      }
    }
    const item = envelope.safeParse(event.data).data;
    if (!runId || item?.runId !== runId) continue;
    const fields = activityFields(item.data);
    const label = native.apply(event.type, fields);
    if (!label) continue;
    const key = fields.id ?? String(event.sequence);
    recent.delete(key);
    recent.set(key, { id: `${session.id}:${event.sequence}`, at: event.at, label });
  }
  work.recent = [...recent.values()].slice(-serverLimits.taskActivityEntries).reverse();
  return work;
}
