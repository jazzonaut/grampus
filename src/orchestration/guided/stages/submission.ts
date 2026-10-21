// Owns the `submission` stage: submitting the implementation attempt with its latest passing
// validation, then handing it to acceptance (automatic) or a human quality assessment (supervised).
// It sends no agent turn and runs no command; it only binds the attempt to the validated artifact.
import { GuidedStopError } from '../stop-reasons.js';
import { evidenceIds, type StageHandler } from '../context.js';
import { automatic } from '../specs.js';
import { required } from '../state.js';
import { selectedLenses } from '../../../domain/quality-passes.js';

/**
 * Submission is proven by the task record itself: the attempt must have succeeded on exactly the
 * artifact this controller validated. `Checks.finish` refuses a validation that is not the latest
 * check or whose artifact has since changed. Without that proof, explicit recovery treats the result
 * as missing, which leaves this read-only step to run again, and a live run throws
 * `SUBMISSION_UNSETTLED`.
 */
export const submissionStage: StageHandler = {
  known: evidenceIds,
  async perform({ state, checks }) {
    await checks.finish(required(state, 'executionId'), required(state, 'validationId'));
    return null;
  },
  settle({ id, state, workflow, recovering }) {
    const task = workflow.get(id);
    if (task.attempt?.artifact !== state.snapshot?.artifact || task.attempt?.outcome !== 'succeeded') {
      if (recovering) return { kind: 'missing' };
      throw new GuidedStopError('SUBMISSION_UNSETTLED', 'Implementation submission did not settle');
    }
    const lenses = selectedLenses(state.plan.quality);
    // Supervised mode with no lenses selected has nothing for a person to assess.
    if (automatic(state) || !lenses.length) return { kind: 'advance', next: 'verification' };
    return {
      kind: 'wait',
      next: 'assessment',
      status: 'awaiting_assessment',
      reason: {
        code: 'ASSESSMENT_REQUIRED',
        note: `Inspect the implementation and validation output. Record an explicit quality assessment (${lenses.map(lens => lens.id).join(', ')}) with task-assess.`,
      },
      update: current => {
        current.assessments = [];
      },
    };
  },
};
