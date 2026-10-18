// Owns the `assessment` stage: recording a simplification assessment as evidence on the current
// artifact. Supervised mode records the human's assessment; automatic mode records the reviewer's.
import { GuidedStopError } from '../stop-reasons.js';
import { adoptOne, evidenceIds, requireOrigin, type StageHandler } from '../context.js';
import { automatic } from '../specs.js';

/**
 * The assessment recorded must be exactly the one supplied with the step intent: same artifact,
 * summary and outcome. Anything else would let evidence drift from what was actually assessed.
 */
export const assessmentStage: StageHandler = {
  known: evidenceIds,
  async perform({ state, checks }) {
    await checks.simplify(state.executionId!, state.pending!.assessment!);
    return null;
  },
  settle(context) {
    const { id, state, pending, workflow } = context;
    const result = adoptOne(
      workflow.get(id).evidence.filter(item => item.kind === 'simplification' && !item.id.endsWith(':requested')),
      pending,
    );
    if (!result)
      return {
        kind: 'wait',
        next: 'assessment',
        status: 'awaiting_assessment',
        reason: {
          code: 'ASSESSMENT_UNSETTLED',
          note: 'No settled assessment was accepted. Inspect and submit it explicitly again.',
        },
        update: current => {
          current.assessment = null;
        },
      };
    requireOrigin(context, state.executionId!, result.id, pending);
    if (
      result.artifact !== pending.assessment?.artifact ||
      result.summary !== pending.assessment.summary ||
      result.outcome !== pending.assessment.outcome
    )
      throw new GuidedStopError('RESULT_MISMATCH', 'Assessment differs from the explicit supplied outcome');
    if (result.outcome !== 'passed')
      return {
        kind: 'stop',
        reason: {
          code: 'SIMPLIFICATION_FAILED',
          note: `Simplification ${result.outcome}; inspect the code and use task-retry for changes.`,
        },
      };
    // Automatic mode assesses after review, so verification follows; supervised mode reviews next.
    return {
      kind: 'advance',
      next: automatic(state) && state.reviewId ? 'verification' : 'review_execution',
      update: current => {
        current.assessment = null;
      },
    };
  },
};
