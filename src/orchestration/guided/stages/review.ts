// Owns the `review` stage: the independent artifact review (or fresh arbitration) by the other
// provider, and the policy for blocking findings: repair within the allowance, then optional
// arbitration, then stop.
import { formatBytes, reviewLimits } from '../../../config/limits.js';
import { reviewRepairRounds } from '../../../domain/guided-plan.js';
import { Sessions, runSession, type Session } from '../../../execution/sessions.js';
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
import type { GuidedState } from '../state.js';
import { reviewPrompt } from '../prompts.js';
import { automatic } from '../specs.js';

function reviewTurnIds({ store, executions }: GuidedContext, state: GuidedState): string[] {
  return store
    .sessionEvents(executions.get(state.reviewId!).sessionId)
    .filter(event => event.type === 'turn.requested')
    .map(event => (event.data as { runId: string }).runId);
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
      'Review history exceeds eight verdicts for this slice; inspect the journal and prepare an approved revision',
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

/**
 * Records the blocking verdict and chooses what happens next, atomically: another repair while the
 * allowance lasts and the artifact changed since the last block, otherwise one fresh arbitration if
 * the plan names an arbitrator, otherwise a stop with the code saying which limit was reached.
 */
function routeBlockingReview(context: SettleContext, execution: Execution): 'repair' | 'arbitration' | StopReasonCode {
  const { store, state, executions, change, prepareRetry } = context;
  return store.transaction(() => {
    const cycle = structuredClone(state.reviewCycle);
    // Blocking the same artifact twice means the last repair changed nothing the reviewer cared about.
    const noProgress = automatic(state) && cycle.history.some(item => item.artifact === execution.artifact);
    cycle.history.push({ executionId: execution.id, artifact: execution.artifact! });
    change('guided.blocking_review', current => {
      current.reviewCycle = cycle;
      current.pending = null;
      current.status = 'blocked';
      current.stopReason = stopReason('REVIEW_BLOCKING_FINDINGS', 'Independent review recorded blocking findings.');
    });
    if (!cycle.arbitrating && !noProgress && cycle.repairs < reviewRepairRounds(state.plan)) {
      cycle.repairs++;
      prepareRetry('guided.review_repair_requested');
      change('guided.repair_budget_used', current => {
        current.reviewCycle = cycle;
      });
      return 'repair';
    }
    if (!cycle.arbitrationUsed && state.plan.reviewPolicy?.arbitrator) {
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
    return noProgress ? 'REVIEW_NO_PROGRESS' : 'REVIEW_REPAIR_EXHAUSTED';
  });
}

/** How the reviewer's verdict was recorded. */
interface Verdict {
  execution: Execution;
  session: Session;
  /** The review evidence recorded for this turn, if any. */
  outcome: string | undefined;
  /** Automatic mode only: the reviewer's simplification assessment failed. */
  simplificationFailed: boolean;
}

/**
 * A verdict that did not pass. Only a settled turn with concrete blocking findings (or, in automatic
 * mode, a failed simplification assessment) gives the implementer something to repair; any other
 * non-passing verdict stops for a person.
 */
function settleUnpassed(context: SettleContext, verdict: Verdict): StageOutcome {
  const { execution, session, outcome, simplificationFailed } = verdict;
  const reply = session.lastReply;
  const repairable =
    session.phase === 'idle' &&
    (simplificationFailed || (outcome === 'failed' && reply?.findings.some(item => item.severity === 'blocking')));
  let code: StopReasonCode;
  if (repairable) {
    const route = routeBlockingReview(context, execution);
    if (route === 'repair' || route === 'arbitration') return { kind: 'rerouted', to: route };
    code = route;
  } else code = session.phase !== 'idle' ? 'REVIEW_TURN_FAILED' : 'REVIEW_FAILED_NO_BLOCKING_FINDINGS';
  return {
    kind: 'stop',
    reason: {
      code,
      note:
        (simplificationFailed ? reply?.simplification?.summary : reply?.text) ||
        'No independent passing review. Inspect the findings, then use task-retry.',
    },
  };
}

/**
 * A passing verdict. In automatic mode the reviewer's own simplification assessment becomes the
 * agent evidence for this artifact, so a pass without one cannot continue.
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
  const assessment = session.lastReply?.simplification;
  if (!assessment || assessment.outcome !== 'passed')
    return {
      kind: 'stop',
      reason: {
        code: 'REVIEW_MISSING_SIMPLIFICATION',
        note: 'The reviewer did not supply a passing simplification assessment. Inspect the verdict before continuing.',
      },
    };
  return {
    kind: 'advance',
    next: 'assessment',
    update: current => {
      current.answers = null;
      current.assessment = {
        ...assessment,
        artifact: state.snapshot!.artifact,
        instructionsDigest: state.snapshot!.instructionsDigest,
        reviewId: execution.id,
      };
    },
  };
}

function settleReview(context: SettleContext): StageOutcome {
  const { id, state, pending, store, executions, workflow } = context;
  const execution = executions.get(state.reviewId!),
    session = new Sessions(store).get(execution.sessionId);
  const turns = store
    .sessionEvents(session.id)
    .filter(event => event.type === 'turn.requested')
    .map(event => ({ id: (event.data as { runId: string }).runId }));
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
    simplificationFailed: automatic(state) && session.lastReply?.simplification?.outcome === 'failed',
  };
  if (session.phase !== 'idle' || verdict.outcome !== 'passed' || verdict.simplificationFailed)
    return settleUnpassed(context, verdict);
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
      executions.get(state.reviewId!).sessionId,
      reviewPrompt({ arbitrating: state.reviewCycle.arbitrating, verdicts }),
      { artifactReview: true, signal, timeoutMs: 0, ...(state.answers ? { answers: state.answers } : {}) },
      services.connector,
      workspaces,
    );
    return null;
  },
  settle: settleReview,
};
