// Owns the `assessment` stage: recording quality lens assessments as evidence on the current
// artifact, one lens per step. Supervised mode records the human's assessment; automatic mode records
// the reviewer's own verdict for each selected lens. It never infers an assessment from checks or
// findings: only an explicitly queued assessment is recorded.
import { deepEqual } from '../../../domain/deep-equal.js';
import { GuidedStopError } from '../stop-reasons.js';
import { adoptOne, evidenceIds, requireOrigin, type StageHandler } from '../context.js';
import { automatic } from '../specs.js';
import { required } from '../state.js';

/**
 * Each step records the head of `assessments`, the queue fixed when the review or the person supplied
 * them. The evidence recorded must be exactly the queued assessment: same lens, artifact, summary and
 * outcome; anything else would let evidence drift from what was actually assessed.
 */
export const assessmentStage: StageHandler = {
  known: evidenceIds,
  async perform({ state, checks }) {
    const assessment = required(state, 'pending').assessment;
    if (!assessment) throw new Error('The assessment step has no queued assessment');
    await checks.assess(required(state, 'executionId'), assessment);
    return null;
  },
  settle(context) {
    const { id, state, pending, workflow } = context;
    // `<runId>:requested` is the pending marker `Checks.assess` records before it claims the lease; it
    // is not an assessment, so only the settled evidence under the run id itself can be adopted.
    const result = adoptOne(
      workflow.get(id).evidence.filter(item => item.kind === 'quality' && !item.id.endsWith(':requested')),
      pending,
    );
    // Assessment writes nothing to the repository, so a missing result is safe to ask for again.
    // Automatic mode records the reviewer's own queued verdicts: recovery repeats the step with the
    // queue intact rather than asking a person to retype what the reviewer already supplied.
    if (!result && automatic(state)) return { kind: 'missing' };
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
          current.assessments = [];
        },
      };
    requireOrigin(context, required(state, 'executionId'), result.id, pending);
    const expected = pending.assessment;
    if (
      !expected ||
      !deepEqual(state.assessments[0], expected) ||
      result.pass !== expected.pass ||
      result.artifact !== expected.artifact ||
      result.summary !== expected.summary ||
      result.outcome !== expected.outcome
    )
      throw new GuidedStopError('RESULT_MISMATCH', 'Assessment differs from the explicit supplied outcome');
    if (result.outcome !== 'passed')
      return {
        kind: 'stop',
        reason: {
          code: 'QUALITY_ASSESSMENT_FAILED',
          note: `Quality assessment (${result.pass}) ${result.outcome}; inspect the code and use task-retry for changes.`,
        },
      };
    const remaining = state.assessments.slice(1);
    if (remaining.length)
      return {
        kind: 'advance',
        next: 'assessment',
        update: current => {
          current.assessments = remaining;
        },
      };
    // Automatic mode assesses after review and delivers; supervised input precedes acceptance.
    return {
      kind: 'advance',
      next: automatic(state) && state.reviewId ? 'delivery' : 'verification',
      update: current => {
        current.assessments = [];
      },
    };
  },
};
