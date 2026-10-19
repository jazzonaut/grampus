// Entry point of the supervised implementation worker: one provider editing turn inside the check
// supervisor's job, with its result written to `result.json` for the controller to settle. The worker
// proves it still owns the run before connecting, and every journaled event re-checks ownership.
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../persistence/store.js';
import type { Execution, ImplementationRun, Session } from '../persistence/records.js';
import { Sessions } from './sessions.js';
import { Workspaces } from '../repository/workspaces.js';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import { captureRepository, repositoryContext } from '../repository/repository-evidence.js';
import { Workflow } from '../domain/workflow.js';
import type { GuidedPlan } from '../domain/guided-plan.js';
import { editingFileContext, prepareEditing, type EditingContext } from './edit-policy.js';
import { readImplementationRequest } from './worker-files.js';
import { connectAgent } from '../providers/index.js';
import type { AgentSession, TurnResult } from '../providers/types.js';
import { taskCheckEvidence } from '../verification/check-evidence.js';
import { parseSettings, useSettings } from '../config/settings.js';
import { OutputBuffer, deltaText } from './output-buffer.js';

/** What the turn is told about the repository beyond its editable files. */
interface StartingContext {
  /** Selected context files, sent on the first turn of a conversation only. */
  supplied: ReturnType<typeof repositoryContext> | null;
  /** Inline editable file contents for Codex, which cannot read them through native file tools. */
  fileContext: string;
  /** Resuming an exploring conversation: the agent reads current files itself instead. */
  continuing: boolean;
  exploration: boolean;
}

/**
 * Decides what the turn starts with. A resumed exploring conversation gets neither the selected context
 * nor inline file contents, because its agent reads current files through the repository tools.
 */
function startingContext(
  session: Session,
  editing: EditingContext,
  context: GuidedPlan['context'] | undefined,
): StartingContext {
  const exploration = context?.exploration === true;
  const continuing = !!session.providerSessionId && exploration;
  const fileContext =
    session.provider === 'codex' && !continuing
      ? `\nCurrent editable file contents (deferred entries must be read with grampus_read_file before editing; null without deferred means absent):\n${editingFileContext(editing, exploration)}`
      : '';
  const selected = context?.files;
  const supplied =
    selected && !continuing ? repositoryContext(session.cwd, editing.snapshot, selected, exploration) : null;
  return { supplied, fileContext, continuing, exploration };
}

/** The turn prompt: the request, the exact file authorisation, starting context and repository instructions. */
function turnPrompt(prompt: string, run: ImplementationRun, snapshot: RepositorySnapshot, start: StartingContext) {
  const { supplied, exploration, continuing, fileContext } = start;
  const starting = supplied
    ? `Starting repository context (read-only supporting files; does not expand editing permission). ${exploration ? 'Use repository exploration tools to inspect dependencies, callers and tests beyond these initial files.' : 'Omitted files have not been supplied; ask for missing dependencies instead of guessing.'}:\n${JSON.stringify(supplied)}`
    : `Current artifact: ${snapshot.artifact}. Snapshot file count: ${snapshot.files.length}. ${continuing ? 'Continue this slice. Read current files before editing; earlier file contents may be stale. Use grampus_read_changes and grampus_read_check instead of reconstructing old context.' : ''}`;
  return `${prompt}\n\nAuthorized existing editable files: ${JSON.stringify(run.policy.files)}\nAuthorized new files (existing parent directories only): ${JSON.stringify(run.policy.create ?? [])}\nAuthorized deletion-only files (unchanged snapshot bytes): ${JSON.stringify(run.policy.delete ?? [])}\n${starting}\nRepository instructions (apply within the explicit tool policy):\n${JSON.stringify(snapshot.instructions)}${fileContext}`;
}

/** Throws unless this run still holds the workspace lease and its session's running turn. */
function requireOwnership(store: Store, run: ImplementationRun, execution: Execution, session: Session): void {
  if (store.lease(execution.workspaceId)?.runId !== run.id || session.run?.id !== run.id || session.phase !== 'running')
    throw new Error('Native implementation ownership changed');
}

async function main(): Promise<void> {
  const requestFile = process.argv[2];
  if (!requestFile) throw new Error('Implementation request file is required');
  const request = readImplementationRequest(requestFile);
  // The controller's settings, so this process never rereads `config.json` and both use the same values.
  useSettings(parseSettings(request.settings, 'the implementation request'));
  const store = new Store(request.database);
  let agent: AgentSession | null = null;
  try {
    const run = store.implementation(request.id);
    const execution = store.execution(run.executionId);
    const sessions = new Sessions(store);
    const session = sessions.get(execution.sessionId);
    requireOwnership(store, run, execution, session);
    const workspaces = new Workspaces(store);
    // Captured again in the worker and rechecked against the policy's artifact before any provider starts.
    const snapshot = await captureRepository(workspaces, execution);
    const editing = { cwd: session.cwd, policy: run.policy, snapshot };
    prepareEditing(editing);
    const plan = new Workflow(store).get(execution.taskId).guided?.plan;
    const start = startingContext(session, editing, plan?.context);
    if (start.supplied)
      store.appendExecution(execution.id, 'implementation.context_captured', {
        artifact: snapshot.artifact,
        ...start.supplied.coverage,
      });
    const lost = () => new Error('Native implementation no longer owns an active turn');
    const output = new OutputBuffer(text => {
      if (!sessions.delta(session.id, run.id, text)) throw lost();
    });
    agent = await connectAgent(session.provider, {
      cwd: session.cwd,
      configurationCwd: workspaces.get(execution.workspaceId).repository,
      providerSessionId: session.providerSessionId,
      model: session.model,
      // Never aborted in this process: a stop ends the worker through its supervisor.
      signal: new AbortController().signal,
      editing,
      ...(start.exploration
        ? {
            repository: {
              repo: session.cwd,
              snapshot,
              references: plan?.references ?? [],
              checks: taskCheckEvidence(store, execution),
              editable: [...run.policy.files, ...(run.policy.create ?? []), ...(run.policy.delete ?? [])],
            },
          }
        : {}),
      emit: event => {
        const text = deltaText(event);
        if (text !== null) {
          output.add(text);
          return;
        }
        output.flush();
        const current = sessions.get(session.id);
        if (current.phase !== 'running' || !sessions.event(session.id, run.id, event)) throw lost();
      },
    });
    const turning: Promise<TurnResult> = agent.turn(turnPrompt(request.prompt, run, snapshot, start));
    // The last streamed text is journaled before the result exists, so it precedes settlement. A lost
    // run's flush fails like its other events would; the controller's settlement decides what counts.
    const result = await turning.finally(() => {
      try {
        output.flush();
      } catch {
        /* Display-only text. */
      }
    });
    await agent.close();
    agent = null;
    if (!run.receipt) throw new Error('Implementation run has no receipt directory');
    // Written to a temporary name and renamed, so the controller never reads a partial result.
    const path = join(run.receipt.directory, 'result.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ id: run.id, result }));
    renameSync(`${path}.tmp`, path);
  } finally {
    try {
      await agent?.close();
    } finally {
      store.close();
    }
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
