// Owns the task's bounded work feed, keeping provider observations separate from controller evidence.
import { serverLimits } from '../../config/limits.js';
import { NativeProgress } from '../../orchestration/native-progress.js';
import type { Session } from '../../persistence/records.js';
import type { Store } from '../../persistence/store.js';
import type { TaskWorkV1 } from '../api-types.js';
import { activityFields, activityPreview } from './activity-events.js';
import { z } from 'zod';

const envelope = z.object({ runId: z.string(), data: z.unknown().optional() });
const message = z.object({
  exitConfirmed: z.literal(true),
  result: z.object({
    status: z.literal('completed'),
    reply: z.object({ kind: z.literal('message'), text: z.string() }),
  }),
});

/** Reads only the displayed session, fences tool observations to its latest run and redacts messages. */
export function taskWorkView(store: Store, session: Session | null): TaskWorkV1 {
  const work: TaskWorkV1 = { recent: [], update: null };
  if (!session) return work;
  const events = store.sessionEvents(session.id);
  const latest = events.findLast(event => event.type === 'turn.requested');
  const runId = session.run?.id ?? activityFields(latest?.data).runId;
  const native = new NativeProgress();
  const recent = new Map<string, TaskWorkV1['recent'][number]>();
  for (const event of events) {
    if (event.type === 'turn.result') {
      const settled = message.safeParse(event.data).data;
      const text = activityPreview(settled?.result.reply.text);
      if (text) work.update = { at: event.at, text };
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
