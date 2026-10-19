// Owns the repository folder choices New task offers from Orca: grouping, names and labels.
// Two repositories can each have a worktree called `main` on `main`, so every choice is shown with its
// repository and full path; the path is what fills the folder field.
import { basename, normalize } from 'node:path';
import type { OrcaWorktree } from '../../repository/orca.js';
import type { OrcaWorktreesV1 } from '../api-types.js';

/** A choice is unavailable when the dashboard has no Orca client or Orca did not answer. */
export const unavailableOrcaWorktrees: OrcaWorktreesV1 = {
  apiVersion: 1,
  available: false,
  repositories: [],
  omitted: 0,
};

/**
 * Groups worktrees by Orca repository. A repository is named after its main worktree's folder (its first
 * listed one when the main worktree is not listed), because Orca's listing carries only an opaque
 * repository id. The main worktree comes first, then by name.
 */
export function orcaWorktreeChoices(worktrees: readonly OrcaWorktree[], omitted: number): OrcaWorktreesV1 {
  const groups = new Map<string, OrcaWorktree[]>();
  for (const entry of worktrees) groups.set(entry.repoId, [...(groups.get(entry.repoId) ?? []), entry]);
  const repositories = [...groups.values()].map(entries => {
    const ordered = entries.toSorted(
      (left, right) => Number(right.isMain) - Number(left.isMain) || left.name.localeCompare(right.name),
    );
    const [main] = ordered;
    return {
      name: main ? basename(normalize(main.path)) : '',
      worktrees: ordered.map(entry => {
        const branch = entry.branch.replace(/^refs\/heads\//, '');
        return { path: normalize(entry.path), label: branch === entry.name ? entry.name : `${entry.name} (${branch})` };
      }),
    };
  });
  return {
    apiVersion: 1,
    available: true,
    repositories: repositories.toSorted((left, right) => left.name.localeCompare(right.name)),
    omitted,
  };
}
