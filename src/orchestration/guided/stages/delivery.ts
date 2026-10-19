// Owns the `delivery` stage: the verified local commit of the checked artifact, then either the
// next slice with fresh allowances and conversations, or completion. A failed delivery stops with its
// retained HEAD, index and files; this stage never repeats a Git write on its own.
import { Deliveries } from '../../../execution/deliveries.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { freshRepairCycle, freshReviewCycle, required, type GuidedState } from '../state.js';
import { deliverySpec } from '../specs.js';

/**
 * Starts the next slice from scratch: its gates, allowances and conversations must not inherit
 * anything from the delivered one, so each delivered slice is verified on its own terms.
 */
function startNextSlice(state: GuidedState): void {
  state.sliceIndex++;
  state.executionId = null;
  state.reviewId = null;
  state.validationId = null;
  state.snapshot = null;
  state.policy = null;
  state.assessments = [];
  state.qualityEdits = [];
  state.feedback = '';
  state.reviewCycle = freshReviewCycle();
  state.repairCycle = freshRepairCycle();
  state.implementationContinuation = null;
  state.reviewContinuation = null;
  state.failedCheckId = null;
  state.retryAnchor = null;
}

/**
 * Delivery is adopted only when the task record itself moved on: complete after the final slice, or
 * ready at exactly the next slice. Any other task phase means the commit was not recorded as this
 * slice's delivery.
 */
export const deliveryStage: StageHandler = {
  known: ({ store }, state) => store.deliveries(required(state, 'executionId')).map(item => item.id),
  // The delivery module itself requires every gate on the current artifact before it stages anything.
  async perform({ state, store, workspaces, signal }) {
    await new Deliveries(store, workspaces).run(required(state, 'executionId'), deliverySpec(state), signal);
    return null;
  },
  settle(context) {
    const { id, state, pending, store, workflow } = context;
    const executionId = required(state, 'executionId');
    const result = adoptOne(store.deliveries(executionId), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, executionId, result.id, pending);
    if (!deepEqual(result.spec, deliverySpec(state)))
      throw mismatch('Delivery result differs from the approved artifact or delivery request');
    requireSettled(result, 'Delivery');
    if (result.phase !== 'delivered')
      return {
        kind: 'stop',
        reason: {
          code: 'DELIVERY_FAILED',
          note: `Delivery ${result.phase}: ${result.error ?? ''}. Inspect retained HEAD/index/files before task-retry.`,
        },
      };
    const task = workflow.get(id);
    if (task.phase === 'complete')
      return {
        kind: 'advance',
        next: 'complete',
        update: current => {
          current.note = 'Task delivered locally. The journal-derived report is available with report.';
        },
      };
    if (task.phase === 'ready' && task.slice?.index === state.sliceIndex + 1)
      return { kind: 'advance', next: 'execution', update: startNextSlice };
    throw mismatch('Delivered result did not advance the approved task');
  },
};
