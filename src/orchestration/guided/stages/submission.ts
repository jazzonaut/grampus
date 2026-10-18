// Owns the `submission` stage: submitting the implementation attempt with its latest passing
// validation, then handing it to review (automatic) or to a human assessment (supervised).
import { GuidedStopError } from '../stop-reasons.js';
import { evidenceIds, type StageHandler } from '../context.js';
import { automatic } from '../specs.js';

/**
 * Submission is proven by the task record itself: the attempt must have succeeded on exactly the
 * artifact this controller validated.
 */
export const submissionStage: StageHandler = {
  known: evidenceIds,
  async perform({ state, checks }) {
    await checks.finish(state.executionId!, state.validationId!);
    return null;
  },
  settle({ id, state, workflow, recovering }) {
    const task = workflow.get(id);
    if (task.attempt?.artifact !== state.snapshot?.artifact || task.attempt?.outcome !== 'succeeded') {
      if (recovering) return { kind: 'missing' };
      throw new GuidedStopError('SUBMISSION_UNSETTLED', 'Implementation submission did not settle');
    }
    if (automatic(state)) return { kind: 'advance', next: 'review_execution' };
    return {
      kind: 'wait',
      next: 'assessment',
      status: 'awaiting_assessment',
      reason: {
        code: 'ASSESSMENT_REQUIRED',
        note: 'Inspect the implementation and validation output. Record an explicit simplification outcome with task-assess.',
      },
      update: current => {
        current.assessment = null;
      },
    };
  },
};
