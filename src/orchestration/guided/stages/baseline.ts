// Owns the `baseline` stage: before a validation or acceptance failure spends a repair, the same
// command runs on the commit the candidate started from. A failure there too predates the change,
// so it stops for a person instead of spending repairs no change can succeed with. The run is a
// decision aid only: it never passes a gate, and a run that cannot stand for the starting commit is
// inconclusive and leaves the ordinary repair decision unchanged.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeCriteria } from '../../../domain/workflow.js';
import { runOnStartingCommit } from '../../../verification/baseline.js';
import { adoptOne, mismatch, workspacePath, type GuidedContext, type StageHandler } from '../context.js';
import { required, type GuidedState } from '../state.js';
import { dueAcceptance } from '../specs.js';
import { recordRepairDecision } from '../repair-policy.js';
import { checkedOnStartingCommit, settleCheckFailure } from './checks.js';

/** One journaled run on the starting commit (`baseline.completed` on the execution). */
const baselineSchema = z.object({
  id: z.string(),
  checkId: z.string(),
  outcome: z.enum(['failed', 'passed', 'inconclusive']),
  reason: z.string(),
  head: z.string(),
  issue: z.string().nullable(),
});

function baselines({ store }: GuidedContext, state: GuidedState) {
  return store
    .executionEvents(required(state, 'executionId'), ['baseline.completed'])
    .map(event => baselineSchema.parse(event.data));
}

export const baselineStage: StageHandler = {
  known: (context, state) => baselines(context, state).map(item => item.id),
  async perform({ state, store, workspaces, services, signal }) {
    const executionId = required(state, 'executionId');
    const check = store.check(required(state, 'failedCheckId'));
    const outcome = await runOnStartingCommit(workspacePath(workspaces, state), check, required(state, 'snapshot'), {
      ...(signal ? { signal } : {}),
      ...(services.baselineRunner ? { runner: services.baselineRunner } : {}),
    });
    store.transaction(() =>
      store.appendExecution(executionId, 'baseline.completed', {
        id: randomUUID(),
        checkId: check.id,
        ...outcome,
      } satisfies z.infer<typeof baselineSchema>),
    );
    return null;
  },
  settle(context) {
    const { id, state, store, workflow, pending } = context;
    const result = adoptOne(baselines(context, state), pending);
    if (!result) return { kind: 'missing' };
    const check = store.check(required(state, 'failedCheckId'));
    if (result.checkId !== check.id || !checkedOnStartingCommit(context, check))
      throw mismatch('Starting-commit run differs from the failed check');
    const stage = check.purpose === 'verification' ? 'verification' : 'validation';
    if (result.outcome === 'failed') {
      recordRepairDecision(context, {
        source: stage,
        action: 'stop',
        reason: 'CHECK_FAILS_WITHOUT_CHANGE',
        resultId: check.id,
        trigger: `${check.spec.name}: ${result.reason}`,
        progress: 'ineligible',
      });
      return {
        kind: 'stop',
        reason: {
          code: 'CHECK_FAILS_WITHOUT_CHANGE',
          note: `${check.spec.name} failed, and ${result.reason.charAt(0).toLowerCase()}${result.reason.slice(1)}. No repair was spent: fix the check or its environment, or revise the plan.\nStarting-commit output:\n${result.issue ?? '(none)'}\nRetained check: ${check.id}`,
        },
      };
    }
    // The change is implicated, or the starting commit could not show otherwise: repair as usual.
    const acceptance =
      stage === 'verification'
        ? dueAcceptance(state, activeCriteria(workflow.get(id)), store.checks(required(state, 'executionId')))
        : null;
    return settleCheckFailure(context, check, acceptance, stage);
  },
};
