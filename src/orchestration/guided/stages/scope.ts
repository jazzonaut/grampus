// Owns the `scope` stage: snapshotting the workspace, enforcing size limits and building the exact
// edit policy for the current slice. Supervised mode stops here for explicit file authorization. It
// edits nothing and sends no agent turn; it only decides what the next turn may touch.
import { prepareEditing } from '../../../execution/edit-policy.js';
import { boundedRepositoryFiles } from '../../../repository/repository-evidence.js';
import { GuidedStopError, withReason } from '../stop-reasons.js';
import { evidenceIds, workspacePath, type StageHandler, type StateUpdate } from '../context.js';
import { required } from '../state.js';
import { afterImplementation, automatic, currentSlice, editPolicy } from '../specs.js';
import { keepSnapshot } from '../snapshots.js';

/**
 * Scope produces no durable leaf record: its evidence is the snapshot `perform` returns, so a
 * recovering controller finds nothing to adopt and simply leaves the step to run again.
 */
export const scopeStage: StageHandler = {
  known: evidenceIds,
  async perform({ state, checks, workspaces }) {
    const snapshot = await checks.snapshot(required(state, 'executionId')),
      cwd = workspacePath(workspaces, state);
    // Automatic repairs must continue from the artifact the failed attempt left; an external change
    // in between would be silently adopted by the next attempt.
    if (
      state.retryAnchor &&
      (snapshot.artifact !== state.retryAnchor.artifact ||
        snapshot.instructionsDigest !== state.retryAnchor.instructionsDigest)
    )
      throw new GuidedStopError(
        'REPAIR_WORKSPACE_CHANGED',
        'Workspace changed between repair attempts; inspect the retained changes before continuing',
      );
    // Refuse an unusable context or file scope now (size limits, missing or ignored paths), before a
    // turn is spent on it.
    withReason('SCOPE_REJECTED', () => {
      boundedRepositoryFiles(cwd, snapshot, state.plan.context.files, state.plan.context.exploration);
      const policy = currentSlice(state).mode === 'no_change' ? null : editPolicy(state, snapshot);
      if (policy) prepareEditing({ cwd, snapshot, policy });
    });
    return snapshot;
  },
  settle({ state, snapshot, store }) {
    if (!snapshot) return { kind: 'missing' };
    const policy = currentSlice(state).mode === 'no_change' ? null : editPolicy(state, snapshot);
    const update: StateUpdate = current => {
      current.snapshot = keepSnapshot(store, snapshot);
      current.policy = policy;
      current.retryAnchor = null;
    };
    if (!automatic(state))
      return {
        kind: 'wait',
        next: 'scope',
        status: 'awaiting_scope',
        reason: {
          code: 'SCOPE_AUTHORIZATION_REQUIRED',
          note: 'Inspect the workspace, repository instructions and exact file scope, then use task-authorize.',
        },
        update,
      };
    // Plan approval already authorized this scope; a slice with nothing to edit skips the turn.
    return {
      kind: 'advance',
      next: policy === null ? afterImplementation(state) : 'implementation',
      update: current => {
        update(current);
        current.note = 'Continuing within the approved file scope.';
      },
    };
  },
};
