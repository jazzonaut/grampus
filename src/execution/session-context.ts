// Owns the resume-or-fresh decision for a slice's provider conversation. It only reads the journal;
// it does not create sessions or start turns.
import type { Store } from '../persistence/store.js';
import type { Session } from './sessions.js';
import type { WorkflowPolicy } from '../domain/workflow-policy.js';
import { currentSettings } from '../config/settings.js';
import { agentToolsetVersion } from '../providers/types.js';
import { z } from 'zod';

/** The input token reading of a journaled `context.updated` event (`{ runId, data }`); unknown when absent. */
const contextUpdateSchema = z.object({ data: z.object({ inputTokens: z.number().optional() }) });

/**
 * Decide whether the next execution may resume `session`'s provider conversation. Decide at a settled
 * boundary using current context, never cumulative token spend: the latest `context.updated` reading is
 * what the provider would carry forward. Turns are counted across every Grampus session that resumed the
 * same provider conversation, since retries create new sessions on one conversation. A Codex session
 * created with an older toolset starts fresh because its thread was registered with the old tools.
 * Returns the decision with a human-readable reason and the figures it was based on.
 */
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
  const context = contextUpdateSchema.safeParse(events.findLast(event => event.type === 'context.updated')?.data);
  const inputTokens = context.data?.data.inputTokens ?? null;
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
