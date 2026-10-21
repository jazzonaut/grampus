// Owns validation of the exact supplemental permission and accompanying questions a human inspected.
import type { Store } from '../../persistence/store.js';
import { pendingDiagnosticAllowance } from '../../execution/diagnostic-allowance.js';
import { guidedDecisionDigest, guidedQuestionKey } from './keys.js';
import { required, type GuidedState } from './state.js';

/** Returns the displayed proposal only while its state and required answers still match. */
export function diagnosticApproval(
  store: Store,
  state: GuidedState,
  expected: string,
  answers: Record<string, string> | undefined,
) {
  if (
    state.stopReason?.code !== 'DIAGNOSTIC_ALLOWANCE_REQUIRED' ||
    guidedDecisionDigest(state, guidedQuestionKey(store, state)) !== expected
  )
    throw new Error('Inspect the current diagnostic allowance request before approving');
  const proposal = pendingDiagnosticAllowance(store, required(state, 'executionId'));
  if (!proposal || proposal.to <= proposal.from)
    throw new Error('Revise the plan; no diagnostic supplement is available');
  const session = store.session(store.execution(required(state, 'executionId')).sessionId);
  const questions = session.phase === 'awaiting_answer' ? (session.lastReply?.questions ?? []) : [];
  if (
    questions.length &&
    (!answers ||
      Object.keys(answers).length !== questions.length ||
      questions.some(question => !answers[question.id]?.trim()))
  )
    throw new Error('Answer the pending questions in the diagnostic allowance approval form');
  if (!questions.length && answers) throw new Error('No questions accompany this diagnostic allowance');
  return proposal;
}
