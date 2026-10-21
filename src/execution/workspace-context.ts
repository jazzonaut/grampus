// Owns conversation rotation between settled native workspace turns without replacing the execution.
import { sessionContinuation } from './session-context.js';
import type { Store } from '../persistence/store.js';

/** Applies approved context limits before another turn; it never repeats a dispatched operation. */
export function prepareWorkspaceContinuation(store: Store, executionId: string): void {
  store.transaction(() => {
    const execution = store.execution(executionId);
    const session = store.session(execution.sessionId);
    if (!session.providerSessionId) return;
    if (session.run || store.lease(execution.workspaceId))
      throw new Error('Conversation rotation requires a settled implementation');
    const task = store.get(execution.taskId);
    const decision = sessionContinuation(store, session, task.guided?.plan.workflowPolicy);
    if (decision.resume) return;
    const previous = session.providerSessionId;
    session.providerSessionId = null;
    store.saveSession(session.id, session);
    const data = { ...decision, previous, executionId, sessionId: session.id };
    store.appendSession(session.id, 'session.context_reset', data);
    store.append(task.id, task.version, 'agent.context_reset', data);
  });
}
