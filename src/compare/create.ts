// Starts a comparison: its log, and the Orca terminal in the repository's main checkout that runs its
// driver. The driver then creates the entries; nothing else runs here.
import { randomBytes } from 'node:crypto';
import { inputLimits } from '../config/limits.js';
import { availableRecipes, currentSettings } from '../config/settings.js';
import type { OrcaWorkspaces } from '../orca/client.js';
import { resolveRepository, slug } from '../pipeline/create-task.js';
import { ComparisonStore, type ComparisonMode } from './comparison.js';

export interface NewComparison {
  dataDir: string;
  repoPath: string;
  request: string;
  title?: string;
  recipeNames: readonly string[];
  mode: ComparisonMode;
  /** The command line that runs the comparison's driver. */
  driveCommand: (comparisonId: string) => string;
}

export async function startComparison(
  input: NewComparison,
  workspaces: OrcaWorkspaces,
): Promise<{ comparisonId: string; repository: string; terminal: string }> {
  const request = input.request.trim();
  if (!request || request.length > inputLimits.requestLength)
    throw new Error(`The request must be between 1 and ${inputLimits.requestLength} characters.`);
  const names = [...new Set(input.recipeNames.map(name => name.trim()).filter(Boolean))];
  if (names.length < 2) throw new Error('A comparison needs at least two different recipes.');
  const known = availableRecipes();
  const recipes = names.map(name => {
    const recipe = known.find(item => item.name === name);
    if (!recipe) throw new Error(`Unknown recipe "${name}". Available: ${known.map(item => item.name).join(', ')}.`);
    return recipe;
  });
  const repository = await resolveRepository(input.repoPath);
  const title = (input.title?.trim() || (request.split(/\r?\n/, 1)[0] ?? request)).slice(0, inputLimits.titleLength);
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
    title: `Grampus comparison: ${title}`,
    command: input.driveCommand(comparisonId),
  });
  store.append({ type: 'comparison.terminal', terminal });
  return { comparisonId, repository, terminal };
}
