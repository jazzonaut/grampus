// Owns the exact prompt of one native implementation turn: the claimed request, the file authorisation,
// the starting repository context and, for Codex, the editable file contents. Every part shares the turn's
// prompt budget, and the worker sends the result unchanged, so what is built here is what the provider
// receives.
import type { Session } from '../persistence/records.js';
import { repositoryContext } from '../repository/repository-evidence.js';
import type { GuidedPlan } from '../domain/guided-plan.js';
import { editingFileContext, type EditingContext } from './edit-policy.js';
import { PromptBudget, promptBytes, requirePromptBudget } from '../providers/prompt-budget.js';

/** The built turn: the prompt to send and the starting context it carries. */
export interface ImplementationTurn {
  prompt: string;
  /** Coverage of the supplied repository context, journaled by the worker; null when none was supplied. */
  coverage: ReturnType<typeof repositoryContext>['coverage'] | null;
  exploration: boolean;
}

const fileContextHeading =
  '\nCurrent editable file contents (deferred entries must be read with grampus_read_file before editing; null without deferred means absent):\n';

/** The text every turn carries whatever context fits: the request and policy, and the repository instructions. */
function fixedText(prompt: string, { policy, snapshot }: EditingContext, exploration: boolean, continuing: boolean) {
  return {
    head: `${prompt}\n\nAuthorized existing editable files: ${JSON.stringify(policy.files)}\nAuthorized new files (existing parent directories only): ${JSON.stringify(policy.create ?? [])}\nAuthorized deletion-only files (unchanged snapshot bytes): ${JSON.stringify(policy.delete ?? [])}\n`,
    tail: `\nRepository instructions (apply within the explicit tool policy):\n${JSON.stringify(snapshot.instructions)}`,
    startingHeading: `Starting repository context (read-only supporting files; does not expand editing permission). ${exploration ? 'Use repository exploration tools to inspect dependencies, callers and tests beyond these initial files.' : 'Omitted files have not been supplied; ask for missing dependencies instead of guessing.'}:\n`,
    artifactLine: `Current artifact: ${snapshot.artifact}. Snapshot file count: ${snapshot.files.length}. ${continuing ? 'Continue this slice. Read current files before editing; earlier file contents may be stale. Use grampus_read_changes and grampus_read_check instead of reconstructing old context.' : ''}`,
  };
}

/**
 * The turn prompt: the request, the exact file authorisation, starting context and repository
 * instructions. The fixed text is charged first, then Codex's editable contents (it cannot read them
 * through native file tools), then the repository context, which does not repeat those files. A resumed
 * exploring conversation gets neither, because its agent reads current files through the repository tools.
 *
 * @throws PromptBudgetError when the required parts cannot fit the turn prompt budget; Error when the
 *   starting context cannot be built for the snapshot.
 */
export function implementationTurn(
  prompt: string,
  session: Pick<Session, 'provider' | 'providerSessionId' | 'cwd'>,
  editing: EditingContext,
  context: GuidedPlan['context'] | undefined,
): ImplementationTurn {
  const { snapshot, policy } = editing;
  const exploration = context?.exploration === true;
  const continuing = !!session.providerSessionId && exploration;
  const inlineFiles = session.provider === 'codex' && !continuing;
  const selected = continuing ? undefined : context?.files;
  const { head, tail, startingHeading, artifactLine } = fixedText(prompt, editing, exploration, continuing);
  const budget = new PromptBudget();
  budget.require(
    promptBytes(`${head}${tail}${selected ? startingHeading : artifactLine}${inlineFiles ? fileContextHeading : ''}`),
    'The implementation request and repository instructions',
    'shorten the guidance or the repository instructions',
  );
  const fileContext = inlineFiles ? `${fileContextHeading}${editingFileContext(editing, exploration, budget)}` : '';
  const elsewhere = new Set(inlineFiles ? [...policy.files, ...(policy.create ?? []), ...(policy.delete ?? [])] : []);
  const supplied = selected
    ? repositoryContext(session.cwd, snapshot, selected, exploration, { budget, elsewhere })
    : null;
  const turn = `${head}${supplied ? `${startingHeading}${JSON.stringify(supplied)}` : artifactLine}${tail}${fileContext}`;
  requirePromptBudget(turn);
  return { prompt: turn, coverage: supplied?.coverage ?? null, exploration };
}
