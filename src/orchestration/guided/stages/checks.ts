// Owns the `validation` and `verification` (acceptance) stages: running the approved checks on the
// current artifact and deciding whether a failure returns to the implementer or stops.
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
import type { GuidedState } from '../state.js';
import { acceptanceSpec, automatic, currentSlice, validationSpec } from '../specs.js';

/** Every check of the current execution, including preparation runs. */
export function checkIds({ store }: GuidedContext, state: GuidedState): string[] {
  return store.checks<RepositoryCheck>(state.executionId!).map(item => item.id);
}

function expectedSpec({ id, workflow }: GuidedContext, state: GuidedState, stage: string) {
  return stage === 'validation' ? validationSpec(state) : acceptanceSpec(state, activeCriteria(workflow.get(id)));
}

/**
 * Why a failed check is not trustworthy evidence about the implementation, or null when it is: it
 * must be a genuine failure with a confirmed exit, fully observed output and unchanged inputs.
 */
function observationProblem(result: RepositoryCheck): StopReasonCode | null {
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
  if (result.after?.artifact !== state.snapshot?.artifact) return 'CHECK_STALE_ARTIFACT';
  if (currentSlice(state).mode === 'no_change') return 'CHECK_FAILED_NO_CHANGE';
  if (!automatic(state)) return 'CHECK_FAILED_SUPERVISED';
  return null;
}

/**
 * Spends one repair from the slice allowance and returns to implementation with the failure as
 * evidence, or stops. A second failure of the same purpose on the same artifact means the last
 * repair changed nothing, so it stops early instead of spending tokens on the same content.
 */
function settleFailure(context: SettleContext, result: RepositoryCheck): StageOutcome {
  const { state, pending, change, prepareRetry } = context;
  const issue = checkIssue(result);
  const cycle = structuredClone(state.repairCycle);
  const noProgress = cycle.failures.some(
    failure => failure.purpose === pending.stage && failure.artifact === state.snapshot?.artifact,
  );
  const allowance = state.plan.workflowPolicy.repairRounds;
  const ineligible = repairIneligibility(state, result);
  change('guided.check_failed', current => {
    current.failedCheckId = result.id;
  });
  if (!ineligible && !noProgress && cycle.used < allowance) {
    cycle.used++;
    cycle.failures.push({ purpose: pending.stage, artifact: state.snapshot!.artifact, issue });
    change('guided.repair_budget_used', current => {
      current.repairCycle = cycle;
    });
    prepareRetry(
      pending.stage === 'validation' ? 'guided.validation_repair_requested' : 'guided.acceptance_repair_requested',
    );
    return { kind: 'rerouted', to: 'repair' };
  }
  const advice = ineligible
    ? 'Inspect the check details before retrying.'
    : noProgress
      ? 'Automatic repair made no content progress; inspect the issue or revise the plan.'
      : `Automatic repair allowance exhausted (${cycle.used}/${allowance}).`;
  // A timeout says first what ran out and what was kept, so the log need not be opened to find out.
  const timeout = ineligible === 'CHECK_TIMEOUT' ? `${timeoutSummary(result)}\n` : '';
  return {
    kind: 'stop',
    reason: {
      code: ineligible ?? (noProgress ? 'CHECK_NO_PROGRESS' : 'CHECK_REPAIR_EXHAUSTED'),
      note: `${timeout}${pending.stage === 'validation' ? 'Validation' : 'Acceptance'} failed: ${issue}\n${advice}\nRetained check: ${result.id}`,
    },
  };
}

function settleCheck(context: SettleContext): StageOutcome {
  const { state, pending, store } = context;
  const result = adoptOne(store.checks<RepositoryCheck>(state.executionId!), pending);
  if (!result) return { kind: 'missing' };
  requireOrigin(context, state.executionId!, result.id, pending);
  if (!deepEqual(result.spec, expectedSpec(context, state, pending.stage)))
    throw mismatch('Check result differs from the approved command or acceptance expectation');
  requireSettled(result, 'Check');
  if (result.phase !== 'passed') return settleFailure(context, result);
  return {
    kind: 'advance',
    next: pending.stage === 'validation' ? 'submission' : 'delivery',
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
    await checks.run(state.executionId!, validationSpec(state), signal);
    return null;
  },
  settle: settleCheck,
};

/** Runs acceptance against every active criterion; a pass is the last gate before delivery. */
export const verificationStage: StageHandler = {
  known: checkIds,
  async perform({ id, state, checks, workflow, signal }) {
    await checks.run(state.executionId!, acceptanceSpec(state, activeCriteria(workflow.get(id))), signal);
    return null;
  },
  settle: settleCheck,
};
