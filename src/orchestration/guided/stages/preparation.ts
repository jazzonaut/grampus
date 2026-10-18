// Owns the `preparation` and `refresh` stages: running the approved restore command before scope,
// and again after implementation, without letting it stand in for validation or acceptance.
import type { RepositoryCheck } from '../../../verification/checks.js';
import { deepEqual } from '../../../domain/deep-equal.js';
import { adoptOne, mismatch, requireOrigin, requireSettled, type StageHandler } from '../context.js';
import { preparationSpec } from '../specs.js';
import { checkIds } from './checks.js';

/**
 * Shared by both stages. A failed preparation stops with its output instead of returning to the
 * implementer: setup problems are not implementation defects, and retrying setup must not spend
 * another implementation attempt.
 */
export const preparationStage: StageHandler = {
  known: checkIds,
  async perform({ state: initial, checks, services, signal, change }) {
    let state = initial;
    if (!state.snapshot) {
      const snapshot = await checks.snapshot(state.executionId!);
      state = change('guided.preparation_snapshot', current => {
        current.snapshot = snapshot;
      });
    }
    await checks.run(state.executionId!, preparationSpec(state), signal, services.preparationRunner);
    return null;
  },
  settle(context) {
    const { state, pending, store } = context;
    const result = adoptOne(store.checks<RepositoryCheck>(state.executionId!), pending);
    if (!result) return { kind: 'missing' };
    requireOrigin(context, state.executionId!, result.id, pending);
    if (!deepEqual(result.spec, preparationSpec(state)) || result.purpose !== 'preparation')
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
    const after = result.after;
    return {
      kind: 'advance',
      next: pending.stage === 'preparation' ? 'scope' : 'validation',
      update: current => {
        current.snapshot = after;
      },
    };
  },
};
