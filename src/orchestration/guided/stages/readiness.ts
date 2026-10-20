// Owns mechanical readiness: explicit read-only checks on the current artifact, before behavioural
// validation. Every attempt reruns them; the separate slice allowance never resets at retry.
import { deepEqual } from '../../../domain/deep-equal.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { dueReadiness } from '../specs.js';
import { required } from '../state.js';
import { checkIds, settleCheckFailure } from './checks.js';

/** Runs and settles one approved readiness check using the same evidence and infrastructure guards as validation. */
export const readinessStage: StageHandler = {
  known: checkIds,
  async perform({ state, store, checks, signal }) {
    const executionId = required(state, 'executionId');
    const spec = dueReadiness(state, store.checks(executionId));
    if (!spec) throw new Error('Every readiness check already passed on this artifact');
    await checks.run(executionId, spec, signal);
    return null;
  },
  settle(context) {
    const { state, pending, store } = context;
    const executionId = required(state, 'executionId');
    const checks = store.checks(executionId);
    const result = adoptOne(checks, pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, executionId, result.id, pending);
    const expected = dueReadiness(
      state,
      checks.filter(check => pending.known.includes(check.id)),
    );
    if (result.purpose !== 'readiness' || !deepEqual(result.spec, expected))
      throw mismatch('Readiness result differs from the approved command or category');
    requireSettled(result, 'Readiness');
    if (result.phase !== 'passed') return settleCheckFailure(context, result, null);
    return {
      kind: 'advance',
      next: dueReadiness(state, checks) ? 'readiness' : 'validation',
      update: current => {
        current.failedCheckId = null;
      },
    };
  },
};
