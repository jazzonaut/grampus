// Owns the `preparation` and `refresh` stages: running the approved restore command before scope,
// and again after implementation, without letting it stand in for validation or acceptance.
import { deepEqual } from '../../../domain/deep-equal.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { afterPreparation, preparationSpec } from '../specs.js';
import { required } from '../state.js';
import { checkIds } from './checks.js';
import { guidedSnapshot, keepSnapshot } from '../snapshots.js';

/**
 * Shared by both stages. A failed preparation stops with its output instead of returning to the
 * implementer: setup problems are not implementation defects, and retrying setup must not spend
 * another implementation attempt.
 */
export const preparationStage: StageHandler = {
  known: checkIds,
  async perform({ state: initial, store, checks, services, signal, change }) {
    let state = initial;
    const executionId = required(state, 'executionId');
    // The first preparation of an attempt has no snapshot yet; journal one first so the request binds
    // to the exact artifact the command starts from, and settlement can rebuild the same request.
    if (!state.snapshot) {
      const snapshot = await checks.snapshot(executionId);
      state = change('guided.preparation_snapshot', current => {
        current.snapshot = keepSnapshot(store, snapshot);
      });
    }
    await checks.run(
      executionId,
      preparationSpec(state, guidedSnapshot(store, state)),
      signal,
      services.preparationRunner,
    );
    return null;
  },
  settle(context) {
    const { state, pending, store } = context;
    const executionId = required(state, 'executionId');
    const result = adoptOne(store.checks(executionId), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, executionId, result.id, pending);
    if (
      !deepEqual(result.spec, preparationSpec(state, guidedSnapshot(store, state))) ||
      result.purpose !== 'preparation'
    )
      throw mismatch('Preparation result differs from the approved command or file scope');
    requireSettled(result, 'Preparation');
    if (result.phase !== 'passed' || !result.after)
      return {
        kind: 'stop',
        reason: {
          code: result.phase === 'interrupted' ? 'PREPARATION_INTERRUPTED' : 'PREPARATION_FAILED',
          note: `Preparation ${result.spec.name} ${result.phase} (${result.result?.reason ?? 'no result'}, exit ${result.result?.exitCode ?? 'unknown'}): ${result.error || result.result?.stderr || result.result?.stdout || 'No output'}. Inspect check-show ${result.id}, then retry preparation in this attempt without repeating implementation.`,
        },
      };
    // Later steps bind to what preparation left: unchanged inputs, or a refresh within the slice scope.
    const after = result.after;
    return {
      kind: 'advance',
      next: pending.stage === 'preparation' ? 'scope' : afterPreparation(state),
      update: current => {
        current.snapshot = keepSnapshot(store, after);
      },
    };
  },
};
