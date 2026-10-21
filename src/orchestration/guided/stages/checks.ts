// Owns the `validation` and `verification` (acceptance) stages: running the approved checks on the
// current artifact and deciding whether a failure returns to the implementer or stops. A slice's
// acceptance checks run one per step, in order, until all have passed or one fails. A failure that
// is not trustworthy evidence about the implementation never spends a repair.
import { activeCriteria } from '../../../domain/workflow.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import type { RepositoryCheck } from '../../../verification/checks.js';
import { checkIssue, timeoutSummary } from '../../../verification/check-output.js';
import type { StopReasonCode } from '../stop-reasons.js';
import {
  adoptOne,
  mismatch,
  requireOrigin,
  requireSettled,
  type GuidedContext,
  type SettleContext,
  type StageHandler,
  type StageOutcome,
} from '../context.js';
import { required, type GuidedState } from '../state.js';
import {
  acceptancePosition,
  automatic,
  currentSlice,
  dueAcceptance,
  regressionCheck,
  validationSpec,
  type DueAcceptance,
} from '../specs.js';
import { recordRepairDecision } from '../repair-policy.js';
import { browserFailureFocus } from '../../../verification/failure-focus.js';

/** The approved budget and journal vocabulary for the failed check's declared stage. */
function failureBudget(state: GuidedState, stage: GuidedState['stage']) {
  if (stage === 'readiness')
    return {
      field: 'readinessCycle' as const,
      allowance: state.plan.workflowPolicy.readinessRounds,
      source: 'readiness' as const,
      label: 'Readiness',
      noProgress: 'READINESS_NO_PROGRESS' as const,
      exhausted: 'READINESS_REPAIR_EXHAUSTED' as const,
      event: 'guided.readiness_budget_used',
      retry: 'guided.readiness_repair_requested',
    };
  if (stage !== 'validation' && stage !== 'verification') throw new Error(`No repair budget for stage ${stage}`);
  return {
    field: 'repairCycle' as const,
    allowance: state.plan.workflowPolicy.repairRounds,
    source: stage,
    label: stage === 'validation' ? 'Validation' : 'Acceptance',
    noProgress: 'CHECK_NO_PROGRESS' as const,
    exhausted: 'CHECK_REPAIR_EXHAUSTED' as const,
    event: 'guided.repair_budget_used',
    retry: stage === 'validation' ? 'guided.validation_repair_requested' : 'guided.acceptance_repair_requested',
  };
}

/** Every check of the current execution, including preparation runs. */
export function checkIds({ store }: GuidedContext, state: GuidedState): string[] {
  return store.checks(required(state, 'executionId')).map(item => item.id);
}

/**
 * The acceptance check a verification step runs, chosen from the checks that existed before the step
 * (`known`), so dispatch and settlement agree on it. Throws when every check has already passed, because
 * the step that saw the last pass moves on to delivery instead.
 */
function stepAcceptance({ id, workflow, store }: GuidedContext, state: GuidedState, known: string[]): DueAcceptance {
  const checks = store.checks(required(state, 'executionId')).filter(check => known.includes(check.id));
  const due = dueAcceptance(state, activeCriteria(workflow.get(id)), checks);
  if (!due) throw new Error('Every acceptance check has already passed on this artifact');
  return due;
}

/**
 * Why a failed check is not trustworthy evidence about the implementation, or null when it is: it
 * must be a genuine failure with a confirmed exit, fully observed output and unchanged inputs.
 */
export function observationProblem(result: RepositoryCheck): StopReasonCode | null {
  const run = result.result;
  if (result.phase !== 'failed') return 'CHECK_INTERRUPTED';
  if (run?.reason === 'timed_out') return 'CHECK_TIMEOUT';
  if (run?.reason === 'output_limit') return 'CHECK_OUTPUT_LIMIT';
  if (run?.reason !== 'exited' || !run.exitConfirmed) return 'CHECK_EXIT_UNCONFIRMED';
  if (run.outputUnavailable) return 'CHECK_OUTPUT_UNAVAILABLE';
  // A check that changed its inputs records an error too; the mutation is the more specific reason.
  if (result.after && result.before?.artifact !== result.after.artifact) return 'CHECK_MUTATED_ARTIFACT';
  // An acceptance mismatch is a normal failure, unless the output it compared was truncated.
  if (result.error && (result.failureKind !== 'acceptance' || run.outputTruncated))
    return result.failureKind === 'acceptance' ? 'CHECK_OUTPUT_TRUNCATED' : 'CHECK_ERROR';
  if (result.before?.artifact !== result.after?.artifact) return 'CHECK_MUTATED_ARTIFACT';
  return null;
}

/**
 * Why a failed check may not be repaired automatically, or null when it may. Only a genuine,
 * confirmed, fully observed failure on the unchanged current artifact is evidence about the
 * implementation; anything else (interruption, timeout, lost output, a check that mutated inputs)
 * is an infrastructure or plan problem that another implementation attempt cannot fix.
 */
export function repairIneligibility(state: GuidedState, result: RepositoryCheck): StopReasonCode | null {
  const problem = observationProblem(result);
  if (problem) return problem;
  if (browserFailureFocus(result).environment) return 'CHECK_ENVIRONMENT_FAILED';
  if (result.after?.artifact !== state.snapshot?.artifact) return 'CHECK_STALE_ARTIFACT';
  if (currentSlice(state).mode === 'no_change') return 'CHECK_FAILED_NO_CHANGE';
  if (!automatic(state)) return 'CHECK_FAILED_SUPERVISED';
  return null;
}

/** Whether the failed check has already been run on the starting commit. */
export function checkedOnStartingCommit({ store }: GuidedContext, result: RepositoryCheck): boolean {
  return store
    .executionEvents(result.executionId, ['baseline.completed'])
    .some(event => (event.data as { checkId?: unknown }).checkId === result.id);
}

/**
 * A regression check's failure not yet run on the starting commit is run there first. Checks of new
 * behaviour are expected to fail there, so only checks the plan marks as regressions qualify.
 */
function startingCommitDue(context: SettleContext, result: RepositoryCheck, stage: GuidedState['stage']): boolean {
  return (
    stage !== 'readiness' && regressionCheck(context.state, result.spec) && !checkedOnStartingCommit(context, result)
  );
}

/**
 * Spends one repair from the slice allowance and returns to implementation with the failure as
 * evidence, or stops. A second failure of the same purpose on the same artifact means the last
 * repair changed nothing, so it stops early instead of spending tokens on the same content.
 * Before a validation or acceptance repair is spent, the check first runs on the starting commit
 * (the `baseline` stage), because no repair of this change can fix a failure that predates it.
 * `stage` is the check's own stage: the pending step's, or the failed check's when settlement resumes
 * from the starting-commit run.
 */
export function settleCheckFailure(
  context: SettleContext,
  result: RepositoryCheck,
  acceptance: DueAcceptance | null,
  stage: GuidedState['stage'],
): StageOutcome {
  const { state, change, prepareRetry } = context;
  const issue = checkIssue(result);
  const position = acceptance ? acceptancePosition(acceptance) : '';
  const budget = failureBudget(state, stage);
  const cycle = structuredClone(state[budget.field]);
  const purpose = result.spec.readiness ? `readiness:${result.spec.name}` : stage;
  const noProgress = cycle.failures.some(
    failure => failure.purpose === purpose && failure.artifact === state.snapshot?.artifact,
  );
  const allowance = budget.allowance;
  const ineligible = repairIneligibility(state, result);
  const canRepair = !ineligible && !noProgress && cycle.used < allowance;
  if (canRepair && startingCommitDue(context, result, stage))
    return {
      kind: 'advance',
      next: 'baseline',
      update: current => {
        current.failedCheckId = result.id;
      },
    };
  const noProgressCode = budget.noProgress;
  const exhaustedCode = budget.exhausted;
  recordRepairDecision(context, {
    source: budget.source,
    action: canRepair ? 'repair' : 'stop',
    reason: ineligible ?? (noProgress ? noProgressCode : canRepair ? 'CHECK_FAILED' : exhaustedCode),
    resultId: result.id,
    trigger: `${result.spec.name}${position}: ${issue}`,
    progress: ineligible
      ? 'ineligible'
      : noProgress
        ? 'stalled'
        : cycle.failures.length
          ? 'artifact_changed'
          : 'initial',
  });
  // Retained whatever follows, so a stop can offer rerun checks and a repair can quote the failure.
  change('guided.check_failed', current => {
    current.failedCheckId = result.id;
  });
  if (canRepair) {
    cycle.used++;
    cycle.failures.push({ purpose, artifact: required(state, 'snapshot').artifact, issue });
    change(budget.event, current => {
      current[budget.field] = cycle;
    });
    prepareRetry(budget.retry);
    return { kind: 'rerouted', to: 'repair' };
  }
  const advice = ineligible
    ? 'Inspect the check details before retrying.'
    : noProgress
      ? 'Automatic repair made no content progress; inspect the issue or revise the plan.'
      : `Automatic repair allowance exhausted (${cycle.used}/${allowance}).`;
  // A timeout says first what ran out and what was kept, so the log need not be opened to find out.
  const timeout = ineligible === 'CHECK_TIMEOUT' ? `${timeoutSummary(result, position)}\n` : '';
  return {
    kind: 'stop',
    reason: {
      code: ineligible ?? (noProgress ? noProgressCode : exhaustedCode),
      note: `${timeout}${budget.label} failed: ${issue}\n${advice}\nRetained check: ${result.id}`,
    },
  };
}

/**
 * Adopts the one new check of this step, only if it ran under this controller with exactly the approved
 * request. A pass on validation becomes the evidence submitted with the implementation; a passed
 * acceptance check leads to the next one, and the last to independent review.
 */
function settleCheck(context: SettleContext): StageOutcome {
  const { state, pending, store } = context;
  const executionId = required(state, 'executionId');
  const result = adoptOne(store.checks(executionId), pending);
  if (!result) return { kind: 'missing' };
  requireOrigin(context, executionId, result.id, pending);
  const acceptance = pending.stage === 'validation' ? null : stepAcceptance(context, state, pending.known);
  if (!deepEqual(result.spec, acceptance ? acceptance.spec : validationSpec(state)))
    throw mismatch('Check result differs from the approved command or acceptance expectation');
  requireSettled(result, 'Check');
  if (result.phase !== 'passed') return settleCheckFailure(context, result, acceptance, pending.stage);
  const last = !acceptance || acceptance.index === acceptance.total - 1;
  return {
    kind: 'advance',
    next: pending.stage === 'validation' ? 'submission' : last ? 'review_execution' : 'verification',
    update: current => {
      current.failedCheckId = null;
      if (pending.stage === 'validation') current.validationId = result.id;
    },
  };
}

/** Runs the approved validation command; a pass is submitted with the implementation. */
export const validationStage: StageHandler = {
  known: checkIds,
  async perform({ state, checks, signal }) {
    await checks.run(required(state, 'executionId'), validationSpec(state), signal);
    return null;
  },
  settle: settleCheck,
};

/**
 * Runs the next acceptance check against every active criterion; passing them all is the last gate
 * before independent review and delivery.
 */
export const verificationStage: StageHandler = {
  known: checkIds,
  async perform(context) {
    const { state, checks, signal } = context;
    const due = stepAcceptance(context, state, required(state, 'pending').known);
    await checks.run(required(state, 'executionId'), due.spec, signal);
    return null;
  },
  settle: settleCheck,
};
