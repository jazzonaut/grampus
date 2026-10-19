// Owns the file contents shown for inspection while a supervised file authorization is pending: the
// exact files in scope, bounded like the agent's own context, read from the retained snapshot.
import { editingScopeFiles } from '../../execution/edit-policy.js';
import { boundedRepositoryFiles } from '../../repository/repository-evidence.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { GuidedState } from '../../orchestration/guided/state.js';

/** The files to inspect before authorizing, or the reason they cannot be prepared. Empty unless authorization is pending. */
export function pendingScopeFiles(
  state: GuidedState,
  workspacePath: string | null,
  snapshot: RepositorySnapshot | null,
): { files: { path: string; content: string | null }[]; error: string | null } {
  if (state.status !== 'awaiting_scope' || !workspacePath || !snapshot) return { files: [], error: null };
  try {
    const slice = state.plan.slices[state.sliceIndex];
    if (!slice) throw new Error('The current slice is missing from the plan');
    const selection = [...new Set([...(state.policy?.files ?? slice.scope.files), ...(slice.scope.delete ?? [])])];
    const current = { ...snapshot, diff: snapshot.diff.filter(change => selection.includes(change.path)) };
    return {
      files: state.policy
        ? editingScopeFiles({ cwd: workspacePath, snapshot: current, policy: state.policy })
        : boundedRepositoryFiles(workspacePath, current, selection),
      error: null,
    };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}
