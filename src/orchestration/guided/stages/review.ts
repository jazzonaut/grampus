// Owns the `review` stage: the independent artifact review (or fresh arbitration) by the other
// provider, and the policy for blocking findings: repair within the allowance, then optional
// arbitration, then stop. The reviewer only reads the submitted artifact, and earlier verdicts are
// never dropped from what it is shown.
import { formatBytes, reviewLimits } from '../../../config/limits.js';
import { blockingFindings, priorBlockingFindings, reviewProgress, recordRepairDecision } from '../repair-policy.js';
import { lensOutcome, selectedLenses, type LensAssessment } from '../../../domain/quality-passes.js';
import {
  Sessions,
  requestedTurnIds,
  runSession,
  turnRefusedForBudget,
  type Session,
} from '../../../execution/sessions.js';
import type { Execution } from '../../../execution/execution-state.js';
import { GuidedStopError, stopReason, type StopReasonCode } from '../stop-reasons.js';
import {
  adoptOne,
  requireOrigin,
  type GuidedContext,
  type SettleContext,
  type StageHandler,
  type StageOutcome,
} from '../context.js';
import { required, type GuidedState } from '../state.js';
import { reviewPrompt } from '../prompts.js';
import { automatic } from '../specs.js';
import { withGuidance } from '../guidance.js';

/** The requested turns of the review session; a review step's result is its one new turn. */
function reviewTurnIds({ store, executions }: GuidedContext, state: GuidedState): string[] {
  return requestedTurnIds(store, executions.get(required(state, 'reviewId')).sessionId);
}

/**
 * Every earlier blocking verdict for this slice, serialised for the next reviewer. History is never
 * truncated: a reviewer that cannot see every earlier finding could silently drop one, so an
 * oversized history stops the task for a revision instead.
 */
function reviewHistory({ store, executions }: GuidedContext, state: GuidedState): string {
  if (state.reviewCycle.history.length > reviewLimits.historyVerdicts)
    throw new GuidedStopError(
      'REVIEW_HISTORY_LIMIT',
      `Review history exceeds ${reviewLimits.historyVerdicts} verdicts for this slice; inspect the journal and prepare an approved revision`,
    );
  const history = state.reviewCycle.history.map(item => ({
    ...item,
    verdict: new Sessions(store).get(executions.get(item.executionId).sessionId).lastReply,
  }));
  const verdicts = JSON.stringify(history);
  if (Buffer.byteLength(verdicts) > reviewLimits.historyBytes)
    throw new GuidedStopError(
      'REVIEW_HISTORY_LIMIT',
      `Review history exceeds ${formatBytes(reviewLimits.historyBytes)}; full findings remain in the journal. Prepare an approved revision rather than omitting findings`,
    );
  return verdicts;
}

/** A first verdict has no earlier blockers to resolve, so it cannot evidence review progress. */
function decisionProgress(priorCount: number, progress: ReturnType<typeof reviewProgress>) {
  return priorCount || progress !== 'progress' ? progress : 'initial';
}

/** Preserve the reviewer's own summary when explaining missing or unresolved progress. */
function progressFailureNote(session: Session): string {
  return session.lastReply?.text || 'Review did not establish resolution of earlier blockers.';
}

/**
 * Records the blocking verdict and chooses what happens next, atomically: another repair while the
 * allowance lasts and the artifact changed since the last block, otherwise one fresh arbitration if
 * the plan names an arbitrator, otherwise a stop with the code saying which limit was reached.
 */
function routeBlockingReview(
  context: SettleContext,
  execution: Execution,
  session: Session,
): 'repair' | 'arbitration' | StopReasonCode {
  const { store, state, executions, change, prepareRetry } = context;
  const artifact = execution.artifact;
  if (!artifact) throw new Error(`Review execution ${execution.id} is not bound to an artifact`);
  return store.transaction(() => {
    const cycle = structuredClone(state.reviewCycle);
    const prior = priorBlockingFindings(context, state);
    const reply = session.lastReply;
    if (!reply) throw new Error('Blocking review has no settled reply');
    const repeatedArtifact = cycle.history.some(item => item.artifact === artifact);
    const progress = repeatedArtifact
      ? 'stalled'
      : reviewProgress(prior, blockingFindings(state, reply, execution.id), reply);
    const noProgress = automatic(state) && progress === 'stalled';
    const unknownProgress = automatic(state) && progress === 'unknown';
    const reason = noProgress
      ? 'REVIEW_NO_PROGRESS'
      : unknownProgress
        ? 'REVIEW_PROGRESS_UNCONFIRMED'
        : 'REVIEW_REPAIR_EXHAUSTED';
    const allowance = state.plan.workflowPolicy.repairRounds;
    const canRepair = !cycle.arbitrating && !noProgress && !unknownProgress && state.repairCycle.used < allowance;
    const arbitrate = !canRepair && !cycle.arbitrationUsed && !!state.plan.reviewPolicy?.arbitrator;
    recordRepairDecision(context, {
      source: 'review',
      action: canRepair ? 'repair' : arbitrate ? 'arbitration' : 'stop',
      reason: canRepair ? 'REVIEW_BLOCKING_FINDINGS' : cycle.arbitrating ? 'ARBITRATION_UNRESOLVED' : reason,
      resultId: execution.id,
      trigger: blockingFindings(state, reply, execution.id)
        .map(finding => `${finding.description}\nEvidence: ${finding.evidence}`)
        .join('\n\n'),
      progress: decisionProgress(prior.length, progress),
    });
    cycle.history.push({ executionId: execution.id, artifact });
    // Retained in every route, so the blocking verdict is on record before any repair or
    // arbitration moves the task on; the transient code is replaced by whatever follows.
    change('guided.blocking_review', current => {
      current.reviewCycle = cycle;
      current.pending = null;
      current.status = 'blocked';
      current.stopReason = stopReason('REVIEW_BLOCKING_FINDINGS', 'Independent review recorded blocking findings.');
    });
    if (canRepair) {
      cycle.repairs++;
      change('guided.repair_budget_used', current => {
        current.reviewCycle = cycle;
        current.repairCycle.used++;
      });
      prepareRetry('guided.review_repair_requested');
      return 'repair';
    }
    if (arbitrate) {
      executions.close(execution.id);
      change('guided.arbitration_requested', current => {
        current.reviewCycle = { ...cycle, arbitrating: true, arbitrationUsed: true };
        current.reviewId = null;
        current.stage = 'review_execution';
        current.status = 'ready';
        current.answers = null;
      });
      return 'arbitration';
    }
    if (cycle.arbitrating) return 'ARBITRATION_UNRESOLVED';
    return reason;
  });
}

/** How the reviewer's verdict was recorded. */
interface Verdict {
  execution: Execution;
  session: Session;
  /** The review evidence recorded for this turn, if any. */
  outcome: string | undefined;
  /** The settled evidence includes the provider error when the turn failed. */
  summary: string | undefined;
  /** Automatic mode only: the selected lenses the reviewer failed. */
  failedLenses: LensAssessment[];
  /** The turn was refused before dispatch because its prompt could not fit the budget. */
  refused: boolean;
}

/**
 * A verdict that did not pass. Only a settled turn with concrete blocking findings (or, in automatic
 * mode, a failed quality lens, which counts as one) gives the implementer something to repair; any
 * other non-passing verdict stops for a person.
 */
function settleUnpassed(context: SettleContext, verdict: Verdict): StageOutcome {
  const { execution, session, outcome, failedLenses } = verdict;
  const reply = session.lastReply;
  const repairable =
    session.phase === 'idle' &&
    (failedLenses.length > 0 || (outcome === 'failed' && reply?.findings.some(item => item.severity === 'blocking')));
  let code: StopReasonCode;
  if (repairable) {
    const route = routeBlockingReview(context, execution, session);
    if (route === 'repair' || route === 'arbitration') return { kind: 'rerouted', to: route };
    code = route;
  } else if (session.phase === 'idle') code = 'REVIEW_FAILED_NO_BLOCKING_FINDINGS';
  else code = verdict.refused ? 'PROMPT_BUDGET_EXCEEDED' : 'REVIEW_TURN_FAILED';
  const note =
    (failedLenses.length ? failedLenses.map(lens => `${lens.lens}: ${lens.summary}`).join('\n') : reply?.text) ||
    'No independent passing review. Inspect the findings, then use task-retry.';
  return {
    kind: 'stop',
    reason: {
      code,
      note:
        (code === 'REVIEW_TURN_FAILED' || code === 'PROMPT_BUDGET_EXCEEDED') && verdict.summary
          ? `${note}\n${verdict.summary}`
          : note,
    },
  };
}

/**
 * A passing verdict. In automatic mode the reviewer's own assessment of each selected lens becomes
 * agent evidence for this artifact, so a pass that leaves a selected lens unassessed cannot continue.
 * With no lenses selected there is nothing to record and acceptance follows.
 */
function settlePassed({ state }: SettleContext, { execution, session }: Verdict): StageOutcome {
  if (!automatic(state))
    return {
      kind: 'advance',
      next: 'verification',
      update: current => {
        current.answers = null;
      },
    };
  const lenses = selectedLenses(state.plan.quality);
  const verdictOf = (id: string) => session.lastReply?.lenses?.find(item => item.lens === id);
  const assessed = lenses.flatMap(lens => {
    const item = verdictOf(lens.id);
    return item?.verdict === 'pass' ? [item] : [];
  });
  const missing = lenses.filter(lens => verdictOf(lens.id)?.verdict !== 'pass').map(lens => lens.id);
  if (missing.length)
    return {
      kind: 'stop',
      reason: {
        code: 'REVIEW_MISSING_LENS',
        note: `The reviewer did not supply a passing assessment of the selected quality lens ${missing.join(', ')}. Inspect the verdict before continuing.`,
      },
    };
  // With no lenses selected nothing is queued, so a snapshot is needed only when there is one.
  const snapshot = assessed.length ? required(state, 'snapshot') : null;
  return {
    kind: 'advance',
    next: lenses.length ? 'assessment' : 'verification',
    update: current => {
      current.answers = null;
      current.assessments = !snapshot
        ? []
        : assessed.map(item => ({
            pass: item.lens,
            outcome: lensOutcome(item.verdict),
            summary: item.summary,
            artifact: snapshot.artifact,
            instructionsDigest: snapshot.instructionsDigest,
            reviewId: execution.id,
          }));
    },
  };
}

/**
 * Adopts the one new review turn of this step, only under this controller. A session that still has a
 * run is uncertain and needs recovery; questions wait for answers; any other verdict is routed as
 * passed or not passed.
 */
function settleReview(context: SettleContext): StageOutcome {
  const { id, state, pending, store, executions, workflow } = context;
  const execution = executions.get(required(state, 'reviewId')),
    session = new Sessions(store).get(execution.sessionId);
  const turns = requestedTurnIds(store, session.id).map(id => ({ id }));
  const turn = adoptOne(turns, pending);
  if (!turn) return { kind: 'missing' };
  requireOrigin(context, execution.id, turn.id, pending);
  if (session.run)
    throw new GuidedStopError('OPERATION_NEEDS_RECOVERY', `Review session needs recovery: ${session.id}`);
  if (session.phase === 'awaiting_answer')
    return {
      kind: 'wait',
      next: 'review',
      status: 'awaiting_answer',
      reason: { code: 'AGENT_QUESTION', note: 'Answer the reviewer questions with task-answer.' },
      update: current => {
        current.answers = null;
      },
    };
  const evidence = workflow.get(id).evidence.find(item => item.kind === 'review' && item.id === turn.id);
  const verdict: Verdict = {
    execution,
    session,
    outcome: evidence?.outcome,
    summary: evidence?.summary,
    refused: turnRefusedForBudget(store, session.id, turn.id),
    failedLenses: automatic(state)
      ? (session.lastReply?.lenses ?? []).filter(
          item => item.verdict === 'fail' && selectedLenses(state.plan.quality).some(lens => lens.id === item.lens),
        )
      : [],
  };
  if (session.phase !== 'idle' || verdict.outcome !== 'passed' || verdict.failedLenses.length)
    return settleUnpassed(context, verdict);
  if (automatic(state)) {
    const reply = session.lastReply;
    const progress = reply ? reviewProgress(priorBlockingFindings(context, state), [], reply) : 'unknown';
    if (progress !== 'progress') {
      const code = state.reviewCycle.arbitrating
        ? 'ARBITRATION_UNRESOLVED'
        : progress === 'stalled'
          ? 'REVIEW_NO_PROGRESS'
          : 'REVIEW_PROGRESS_UNCONFIRMED';
      recordRepairDecision(context, {
        source: 'review',
        action: 'stop',
        reason: code,
        resultId: execution.id,
        trigger: progressFailureNote(session),
        progress,
      });
      return {
        kind: 'stop',
        reason: {
          code,
          note: progressFailureNote(session),
        },
      };
    }
  }
  return settlePassed(context, verdict);
}

/**
 * Review and arbitration turns have no deadline. The reviewer inspects the current artifact
 * read-only (`artifactReview`), with every earlier verdict for the slice in its prompt.
 */
export const reviewStage: StageHandler = {
  known: reviewTurnIds,
  async perform(context) {
    const { state, store, executions, workspaces, services, signal } = context;
    const verdicts = reviewHistory(context, state);
    await runSession(
      store,
      executions.get(required(state, 'reviewId')).sessionId,
      withGuidance(
        reviewPrompt({
          arbitrating: state.reviewCycle.arbitrating,
          verdicts,
          lenses: selectedLenses(state.plan.quality),
          priorFindings: priorBlockingFindings(context, state),
        }),
        state,
      ),
      { artifactReview: true, signal, timeoutMs: 0, ...(state.answers ? { answers: state.answers } : {}) },
      services.connector,
      workspaces,
    );
    return null;
  },
  settle: settleReview,
};
