import { Store } from './store.js';
import { Sessions, runSession } from './sessions.js';
import type { Connector, Provider } from './agents/types.js';

/** Invalid model output leaves the description fallback intact. */
export function parseTaskTitle(value: string): string | null {
  const title = value.trim();
  if (!title || [...title].length > 70 || /[\x00-\x1f\x7f<>`{}\[\]]/.test(title)) return null;
  return title;
}

/** One independent, best-effort naming turn per planning conversation. */
export async function generateTaskTitle(store: Store, id: string, config: { provider: Provider; repo: string; request: string; timeoutMs?: number }, signal: AbortSignal, connector?: Connector): Promise<void> {
  try {
    signal.throwIfAborted();
    const session = store.transaction(() => {
      if (store.sessionEvents(id).some(event => event.type === 'kickoff.title_started' || event.type === 'kickoff.candidate')) return null;
      const created = new Sessions(store).create(config.provider, config.repo);
      store.appendSession(id, 'kickoff.title_started', { sessionId: created.id });
      return created;
    });
    if (!session) return;
    const result = await runSession(store, session.id, `Name this task from its description:\n${JSON.stringify(config.request)}`, {
      purpose: 'title', signal,
    }, connector);
    const title = result.status === 'completed' && result.reply?.kind === 'message' ? parseTaskTitle(result.reply.text) : null;
    if (title && !signal.aborted) store.transaction(() => {
      if (!new Sessions(store).get(id).deletedAt) store.appendSession(id, 'kickoff.title_generated', { title });
    });
  } catch {
    // Naming must never fail or change the planner's conversation.
  }
}
