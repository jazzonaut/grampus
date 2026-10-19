import type { Store } from '../persistence/store.js';
import type { Session } from './sessions.js';
import type { WorkflowPolicy } from '../domain/workflow-policy.js';
import { currentSettings } from '../config/settings.js';
import { agentToolsetVersion } from '../providers/types.js';

/** Decide at a settled boundary using current context, never cumulative token spend. */
export function sessionContinuation(
  store: Store,
  session: Session,
  policy: WorkflowPolicy = currentSettings().defaultWorkflowPolicy,
) {
  const peers = store
    .sessions()
    .filter(item => item.provider === session.provider && item.providerSessionId === session.providerSessionId);
  const events = peers
    .flatMap(item => store.sessionEvents(item.id, ['turn.requested', 'context.updated']))
    .sort((a, b) => a.sequence - b.sequence);
  const turns = events.filter(event => event.type === 'turn.requested').length;
  const context = events.findLast(event => event.type === 'context.updated')?.data as
    { data?: { inputTokens?: number } } | undefined;
  const inputTokens = context?.data?.inputTokens ?? null;
  const outdatedTools = session.provider === 'codex' && session.toolsetVersion !== agentToolsetVersion;
  const reason = !session.providerSessionId
    ? 'No resumable provider conversation'
    : outdatedTools
      ? 'Start fresh to install the current evidence and dependency tools'
      : turns >= policy.maxSessionTurns
        ? `Conversation reached ${policy.maxSessionTurns} turns`
        : inputTokens !== null && inputTokens >= policy.maxContextTokens
          ? `Current context reached ${policy.maxContextTokens} input tokens`
          : 'Continue the same slice with its existing context';
  return {
    resume:
      !!session.providerSessionId &&
      !outdatedTools &&
      turns < policy.maxSessionTurns &&
      (inputTokens === null || inputTokens < policy.maxContextTokens),
    reason,
    turns,
    inputTokens,
  };
}
