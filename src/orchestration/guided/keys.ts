// Owns the decision and question keys that bind a human decision to the exact task state shown to
// that person, so a stale dashboard tab or CLI view cannot act on a changed task. Keys are derived on
// demand and never stored; callers compare them, this module only computes them.
import { createHash } from 'node:crypto';
import type { Store } from '../../persistence/store.js';
import { Sessions } from '../../execution/sessions.js';
import { required, type GuidedState } from './state.js';

/**
 * Identifies the pending questions: the session, its latest requested turn and the questions asked.
 * Answers bind to this key so they can never be applied to a later turn's questions. Null unless the
 * task is awaiting an answer; throws when the questioning execution is missing from the state.
 */
export function guidedQuestionKey(store: Store, state: GuidedState): string | null {
  if (state.status !== 'awaiting_answer') return null;
  const execution = store.execution(required(state, state.stage === 'review' ? 'reviewId' : 'executionId'));
  const session = new Sessions(store).get(execution.sessionId);
  const turn = store.sessionEvents(session.id).findLast(event => event.type === 'turn.requested');
  return createHash('sha256')
    .update(JSON.stringify({ sessionId: session.id, turn, questions: session.lastReply?.questions }))
    .digest('hex');
}

/**
 * Everything a decision depends on: plan version and digest, position, artifact, instructions,
 * executions, the failed check on display and, for answers, the question key. The controller
 * recomputes and compares it. Runner ownership and the stop/pause flags are not part of it, so claiming
 * the runner leaves the key unchanged and the inspected decision still applies.
 */
export function guidedDecisionKey(state: GuidedState, questionKey: string | null = null): string {
  return JSON.stringify({
    version: state.version,
    digest: state.digest,
    status: state.status,
    stage: state.stage,
    artifact: state.snapshot?.artifact ?? null,
    instructionsDigest: state.snapshot?.instructionsDigest ?? null,
    executionId: state.executionId,
    reviewId: state.reviewId,
    failedCheckId: state.failedCheckId,
    questionKey,
  });
}

/**
 * The SHA-256 digest of a decision key. Commands take the digest rather than the key itself, because
 * a JSON argument does not survive every Windows shell's quoting intact.
 */
export function decisionKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The digest of the current decision key, as `task-show` prints it for commands that need one. */
export function guidedDecisionDigest(state: GuidedState, questionKey: string | null = null): string {
  return decisionKeyDigest(guidedDecisionKey(state, questionKey));
}
