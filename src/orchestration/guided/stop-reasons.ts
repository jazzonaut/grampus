// Owns the typed reason codes recorded whenever the guided controller stops making progress: waiting
// for a person, blocked on a settled failure, or requiring explicit recovery. The note stays the primary
// text for people; the code is for the rerun-checks rule, the dashboard, reports and tests, so none of
// them parses note wording. This module only names and records reasons; it never decides when to stop.
import { z } from 'zod';

/**
 * Every reason the guided controller can record for a stop. Each code names one decision point in
 * the controller; the TSDoc says when it is recorded.
 */
export const StopReasonCode = {
  // Waiting for a person.
  /** A new or revised plan waits for approval of its exact version and digest. */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  /** A person paused at a settled operation boundary; continuation preserves the attempt. */
  USER_PAUSED: 'USER_PAUSED',
  /** Unassigned guidance must be resolved before delivery; it never starts another paid turn itself. */
  GUIDANCE_PENDING: 'GUIDANCE_PENDING',
  /** Supervised mode: the exact file scope waits for explicit authorization. */
  SCOPE_AUTHORIZATION_REQUIRED: 'SCOPE_AUTHORIZATION_REQUIRED',
  /** Supervised mode: a human quality assessment of the selected lenses is required after submission. */
  ASSESSMENT_REQUIRED: 'ASSESSMENT_REQUIRED',
  /** An assessment step settled without an accepted assessment; it must be supplied again. */
  ASSESSMENT_UNSETTLED: 'ASSESSMENT_UNSETTLED',
  /** The implementer or reviewer asked structured questions. */
  AGENT_QUESTION: 'AGENT_QUESTION',

  // Settled failures that stop for attention.
  /** An approved preparation command settled without passing. */
  PREPARATION_FAILED: 'PREPARATION_FAILED',
  /** An approved preparation command was interrupted, usually by a stop request. */
  PREPARATION_INTERRUPTED: 'PREPARATION_INTERRUPTED',
  /** The implementation turn failed or returned no settled artifact. */
  IMPLEMENTATION_FAILED: 'IMPLEMENTATION_FAILED',
  /** The implementation turn was interrupted, usually by a stop request. */
  IMPLEMENTATION_INTERRUPTED: 'IMPLEMENTATION_INTERRUPTED',
  /** An edit quality pass turn failed, was interrupted or returned no settled artifact. */
  QUALITY_PASS_FAILED: 'QUALITY_PASS_FAILED',
  /** Files were staged or unstaged during the implementation, so its Git checkpoint changed. */
  CHECKPOINT_CHANGED: 'CHECKPOINT_CHANGED',
  /** The workspace changed between automatic repair attempts. */
  REPAIR_WORKSPACE_CHANGED: 'REPAIR_WORKSPACE_CHANGED',
  /** The retained workspace changed after a revised plan was approved. */
  REVISION_WORKSPACE_CHANGED: 'REVISION_WORKSPACE_CHANGED',
  /** The approved file scope or selected context is no longer valid for the current workspace. */
  SCOPE_REJECTED: 'SCOPE_REJECTED',
  /** Supervised mode: a failed check always waits for a manual retry. */
  CHECK_FAILED_SUPERVISED: 'CHECK_FAILED_SUPERVISED',
  /** A no-change slice failed a check; there is nothing an implementer may repair. */
  CHECK_FAILED_NO_CHANGE: 'CHECK_FAILED_NO_CHANGE',
  /** A check was interrupted rather than failing on its own. */
  CHECK_INTERRUPTED: 'CHECK_INTERRUPTED',
  /** A check exceeded its approved timeout. */
  CHECK_TIMEOUT: 'CHECK_TIMEOUT',
  /** A check exceeded the combined output limit. */
  CHECK_OUTPUT_LIMIT: 'CHECK_OUTPUT_LIMIT',
  /** A check did not exit normally with a confirmed process exit. */
  CHECK_EXIT_UNCONFIRMED: 'CHECK_EXIT_UNCONFIRMED',
  /** A check's output could not be read, so its failure cannot be diagnosed. */
  CHECK_OUTPUT_UNAVAILABLE: 'CHECK_OUTPUT_UNAVAILABLE',
  /** An acceptance comparison failed on truncated output, so the evidence is incomplete. */
  CHECK_OUTPUT_TRUNCATED: 'CHECK_OUTPUT_TRUNCATED',
  /** The check runner recorded an error other than an acceptance mismatch. */
  CHECK_ERROR: 'CHECK_ERROR',
  /** The check changed repository inputs while it ran. */
  CHECK_MUTATED_ARTIFACT: 'CHECK_MUTATED_ARTIFACT',
  /** The check ran against a different artifact from the one the controller holds. */
  CHECK_STALE_ARTIFACT: 'CHECK_STALE_ARTIFACT',
  /** An automatic repair left the failing artifact unchanged. */
  CHECK_NO_PROGRESS: 'CHECK_NO_PROGRESS',
  /** A check failed after the slice's shared repair allowance was used up. */
  CHECK_REPAIR_EXHAUSTED: 'CHECK_REPAIR_EXHAUSTED',
  /** A recorded quality lens assessment did not pass (in practice the human's, in supervised mode). */
  QUALITY_ASSESSMENT_FAILED: 'QUALITY_ASSESSMENT_FAILED',
  /** Transient: a blocking review was recorded and the controller is choosing repair, arbitration or a stop. */
  REVIEW_BLOCKING_FINDINGS: 'REVIEW_BLOCKING_FINDINGS',
  /** Blocking findings remain after the slice's shared repair allowance was used up. */
  REVIEW_REPAIR_EXHAUSTED: 'REVIEW_REPAIR_EXHAUSTED',
  /** The reviewer blocked the same artifact it had already blocked. */
  REVIEW_NO_PROGRESS: 'REVIEW_NO_PROGRESS',
  /** The reviewer did not account for every prior blocker with a unique evidenced disposition. */
  REVIEW_PROGRESS_UNCONFIRMED: 'REVIEW_PROGRESS_UNCONFIRMED',
  /** The fresh arbitrator kept a blocking finding. */
  ARBITRATION_UNRESOLVED: 'ARBITRATION_UNRESOLVED',
  /** The review did not pass but named no blocking finding to repair. */
  REVIEW_FAILED_NO_BLOCKING_FINDINGS: 'REVIEW_FAILED_NO_BLOCKING_FINDINGS',
  /** The review turn itself failed or was interrupted. */
  REVIEW_TURN_FAILED: 'REVIEW_TURN_FAILED',
  /** Automatic mode: a passing review did not assess every selected quality lens. */
  REVIEW_MISSING_LENS: 'REVIEW_MISSING_LENS',
  /** The slice's review history is too long to resend in full. */
  REVIEW_HISTORY_LIMIT: 'REVIEW_HISTORY_LIMIT',
  /** Local delivery settled without a verified commit. */
  DELIVERY_FAILED: 'DELIVERY_FAILED',

  // Results that cannot be adopted, and uncertain work.
  /** A step returned without a durable result. */
  RESULT_MISSING: 'RESULT_MISSING',
  /** More than one new result matches a step, so none can be adopted. */
  RESULT_AMBIGUOUS: 'RESULT_AMBIGUOUS',
  /** A new result was produced under a different controller's lease. */
  RESULT_FOREIGN: 'RESULT_FOREIGN',
  /** A result differs from the exact request the step journaled. */
  RESULT_MISMATCH: 'RESULT_MISMATCH',
  /** The leaf operation behind a step is itself still running or needs recovery. */
  OPERATION_NEEDS_RECOVERY: 'OPERATION_NEEDS_RECOVERY',
  /** Submission returned without a settled successful attempt. */
  SUBMISSION_UNSETTLED: 'SUBMISSION_UNSETTLED',
  /** The controller exited with a pending step or unsettled workspace. */
  SETTLEMENT_UNCONFIRMED: 'SETTLEMENT_UNCONFIRMED',
  /** Explicit recovery could not prove what happened. */
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  /** A step failed after it may have dispatched work, without a more specific code. */
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  /** A step failed before dispatch, without a more specific code. */
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

/** One of the {@link StopReasonCode} values. */
export type StopReasonCode = (typeof StopReasonCode)[keyof typeof StopReasonCode];

/**
 * Why the guided task is not progressing. Present exactly while the status is a stop status
 * (draft, awaiting_*, blocked or recovery_required); cleared whenever work resumes.
 */
export const stopReasonSchema = z.object({
  code: z.enum(StopReasonCode),
  /** The human-readable explanation recorded with the stop; usually the task note. */
  message: z.string(),
  /** ISO timestamp of the stop. */
  at: z.string(),
});
export type StopReason = z.infer<typeof stopReasonSchema>;

/** Records a stop reason now. */
export function stopReason(code: StopReasonCode, message: string): StopReason {
  return { code, message, at: new Date().toISOString() };
}

/**
 * An error raised at a known controller decision point. The message is unchanged from the plain
 * error it replaces; the code lets the drive loop record a specific reason instead of a generic one.
 */
export class GuidedStopError extends Error {
  constructor(
    readonly code: StopReasonCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GuidedStopError';
  }
}

/** The code of a {@link GuidedStopError}, or `fallback` for any other error. */
export function errorReasonCode(error: unknown, fallback: StopReasonCode): StopReasonCode {
  return error instanceof GuidedStopError ? error.code : fallback;
}

/**
 * Runs `action`, giving any plain error it throws the reason `code`. Used around calls into other
 * modules whose errors are expected stops for this step; the message is preserved exactly.
 */
export function withReason<T>(code: StopReasonCode, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof GuidedStopError || !(error instanceof Error)) throw error;
    throw new GuidedStopError(code, error.message, { cause: error });
  }
}
