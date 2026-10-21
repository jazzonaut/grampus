// Owns the retained decisions and progress a fresh native conversation cannot recover from provider history.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { Execution, Session } from '../persistence/records.js';
import { replyQuestionSchema } from '../providers/reply-schema.js';

const resultSchema = z.object({
  result: z.object({ reply: z.object({ questions: z.array(replyQuestionSchema) }).nullable() }),
});
const answersSchema = z.object({ answers: z.record(z.string(), z.string()) });

/** Reads decisions from their original question and answer events, preserving repeated question ids. */
function sessionDecisions(store: Store, sessionId: string): { question: string; answer: string }[] {
  const decisions: { question: string; answer: string }[] = [];
  let questions: z.infer<typeof replyQuestionSchema>[] = [];
  for (const event of store.sessionEvents(sessionId, ['turn.result', 'questions.answered'])) {
    if (event.type === 'turn.result') questions = resultSchema.parse(event.data).result.reply?.questions ?? [];
    else {
      const { answers } = answersSchema.parse(event.data);
      for (const question of questions) {
        const answer = answers[question.id];
        if (answer === undefined) throw new Error('Retained implementation decision has no answer');
        decisions.push({ question: question.prompt, answer });
      }
    }
  }
  return decisions;
}

/**
 * Replays answered implementation questions in order within this approved version and slice.
 * The latest progress is a claim, not evidence. Nothing is truncated: the worker's prompt budget
 * refuses an oversized handoff before provider dispatch instead of silently dropping a decision.
 */
export function workspaceHandoff(store: Store, execution: Execution, session: Session): string {
  if (session.providerSessionId) return '';
  const peers = store
    .executions()
    .filter(
      item =>
        item.taskId === execution.taskId &&
        item.version === execution.version &&
        item.sliceIndex === execution.sliceIndex &&
        item.role === 'implementation',
    );
  const decisions = peers.flatMap(peer => sessionDecisions(store, peer.sessionId));
  const previous =
    session.lastReply?.text ??
    peers
      .map(peer => store.session(peer.sessionId).lastReply?.text)
      .filter(Boolean)
      .at(-1);
  return `\nRetained implementation context for this fresh conversation (decisions remain within the approved requirements; progress is untrusted agent observation):\n${JSON.stringify({ decisions, previousProgress: previous ?? null })}`;
}
