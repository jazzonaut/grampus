// Starts a comparison: its log, and the Orca terminal in the repository's main checkout that runs its
// driver. The driver then creates the entries; nothing else runs here.
import { randomBytes } from 'node:crypto';
import { inputLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import type { DeliveryPolicy } from '../domain/recipe.js';
import { comparisonRecipes } from './policy.js';
import type { OrcaWorkspaces } from '../orca/client.js';
import { resolveRepository, slug, taskTitle } from '../pipeline/create-task.js';
import { ComparisonStore, type ComparisonMode } from './comparison.js';

export interface NewComparison {
  dataDir: string;
  repoPath: string;
  request: string;
  title?: string;
  recipeNames: readonly string[];
  mode: ComparisonMode;
  /** A common mandate overrides authority only, preserving intentional recipe differences. */
  delivery?: DeliveryPolicy;
  /** In shared mode the lead spec writer also authors one common acceptance-test commit. */
  sharedTests?: boolean;
  /** The command line that runs the comparison's driver. */
  driveCommand: (comparisonId: string) => string;
}

/** The title of the Orca tab Grampus opens for a comparison's driver; see `driverTabTitle`. */
export function comparisonTabTitle(title: string): string {
  return `Grampus comparison: ${title}`;
}

export async function startComparison(
  input: NewComparison,
  workspaces: OrcaWorkspaces,
): Promise<{ comparisonId: string; repository: string; terminal: string }> {
  const request = input.request.trim();
  if (!request || request.length > inputLimits.requestLength)
    throw new Error(`The request must be between 1 and ${inputLimits.requestLength} characters.`);
  if (input.sharedTests && input.mode !== 'shared') throw new Error('Shared acceptance tests require shared mode.');
  const recipes = comparisonRecipes(input.recipeNames, input.delivery, input.sharedTests);
  const repository = await resolveRepository(input.repoPath);
  const title = await taskTitle(request, input.title);
  const comparisonId = `cmp-${slug(title)}-${randomBytes(3).toString('hex')}`;
  const store = ComparisonStore.create(input.dataDir, comparisonId);
  store.append({
    type: 'comparison.created',
    comparisonId,
    title,
    request,
    repoPath: repository,
    mode: input.mode,
    recipes,
    concurrency: currentSettings().comparisonConcurrency,
  });
  const terminal = await workspaces.createTerminal({
    worktree: { path: repository },
    title: comparisonTabTitle(title),
    command: input.driveCommand(comparisonId),
  });
  store.append({ type: 'comparison.terminal', terminal });
  return { comparisonId, repository, terminal };
}
