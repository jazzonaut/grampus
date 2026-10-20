// Owns mechanical readiness: explicit read-only checks on the current artifact, before behavioural
// validation. Each gate runs or adopts exact-input evidence; the slice allowance never resets at retry.
import { deepEqual } from '../../../domain/deep-equal.js';
import { mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { dueReadiness, readinessBatch } from '../specs.js';
import { required } from '../state.js';
import { checkIds, observationProblem, settleCheckFailure } from './checks.js';

/** Runs and settles one approved readiness check using the same evidence and infrastructure guards as validation. */
export const readinessStage: StageHandler = {
  known: checkIds,
  async perform({ state, store, checks, signal }) {
    const executionId = required(state, 'executionId');
    const specs = readinessBatch(state, store.checks(executionId));
    const first = specs[0];
    if (!first) throw new Error('Every readiness check already passed on this artifact');
    if (specs.length === 1) await checks.run(executionId, first, signal);
    else await checks.readinessGroup(executionId, specs, signal);
    return null;
  },
  settle(context) {
    const { state, pending, store } = context;
    const executionId = required(state, 'executionId');
    const checks = store.checks(executionId);
    const results = checks.filter(check => !pending.known.includes(check.id));
    if (!results.length) return { kind: 'missing' };
    const expected = readinessBatch(
      state,
      checks.filter(check => pending.known.includes(check.id)),
    );
    if (results.length !== expected.length)
      throw mismatch('Readiness group result count differs from its approved request');
    const groupId = results[0]?.groupId;
    if (
      results.length > 1 &&
      (!groupId || !results.some(result => result.id === groupId) || results.some(result => result.groupId !== groupId))
    )
      throw mismatch('Readiness children do not share this step group');
    for (const [index, result] of results.entries()) {
      requireOrigin(context, executionId, result.groupId ?? result.id, pending);
      if (result.purpose !== 'readiness' || !deepEqual(result.spec, expected[index]))
        throw mismatch('Readiness result differs from the approved command or category');
      requireSettled(result, 'Readiness');
    }
    const infrastructure = results.find(result => result.phase !== 'passed' && observationProblem(result));
    if (infrastructure) return settleCheckFailure(context, infrastructure, null);
    const next = dueReadiness(state, checks, true);
    if (!next) {
      const failedSpec = dueReadiness(state, checks);
      const failed = failedSpec ? checks.findLast(check => deepEqual(check.spec, failedSpec)) : undefined;
      if (failed) return settleCheckFailure(context, failed, null);
    }
    return {
      kind: 'advance',
      next: next ? 'readiness' : 'validation',
      update: current => {
        current.failedCheckId = null;
      },
    };
  },
};
