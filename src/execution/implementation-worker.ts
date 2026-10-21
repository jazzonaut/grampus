// Entry point of the supervised implementation worker: one provider editing turn inside the check
// supervisor's job, with its result written to `result.json` for the controller to settle. The worker
// proves it still owns the run before connecting, and every journaled event re-checks ownership.
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../persistence/store.js';
import type { Execution, ImplementationRun, Session } from '../persistence/records.js';
import { Sessions } from './sessions.js';
import { Workspaces } from '../repository/workspaces.js';
import { captureRepository } from '../repository/repository-evidence.js';
import { Workflow } from '../domain/workflow.js';
import { prepareEditing } from './edit-policy.js';
import { implementationTurn, type ImplementationTurn } from './implementation-prompt.js';
import { PromptBudgetError } from '../providers/prompt-budget.js';
import { readImplementationRequest } from './worker-files.js';
import { connectAgent } from '../providers/index.js';
import type { AgentSession, TurnResult } from '../providers/types.js';
import { taskCheckEvidence } from '../verification/check-evidence.js';
import { parseSettings, useSettings } from '../config/settings.js';
import { OutputBuffer, deltaText } from './output-buffer.js';
import { ImplementationCommands } from './implementation-commands.js';
import { measurePhase } from './phase-timing.js';

/** Throws unless this run still holds the workspace lease and its session's running turn. */
function requireOwnership(store: Store, run: ImplementationRun, execution: Execution, session: Session): void {
  if (store.lease(execution.workspaceId)?.runId !== run.id || session.run?.id !== run.id || session.phase !== 'running')
    throw new Error('Native implementation ownership changed');
}

/** Writes the turn's result to a temporary name and renames it, so the controller never reads a partial one. */
function writeResult(run: ImplementationRun, result: TurnResult): void {
  if (!run.receipt) throw new Error('Implementation run has no receipt directory');
  const path = join(run.receipt.directory, 'result.json');
  writeFileSync(`${path}.tmp`, JSON.stringify({ id: run.id, result }));
  renameSync(`${path}.tmp`, path);
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
    const snapshot = await measurePhase(store, execution.id, 'snapshot', () =>
      captureRepository(workspaces, execution),
    );
    const editing = { cwd: session.cwd, policy: run.policy, snapshot };
    prepareEditing(editing);
    const workspace = run.policy.workspace === true;
    const commands = workspace ? null : new ImplementationCommands(store, run.id);
    const plan = new Workflow(store).get(execution.taskId).guided?.plan;
    let turn: ImplementationTurn;
    try {
      turn = implementationTurn(
        `${request.prompt}\n${commands?.available ? commands.instructions() : ''}`,
        session,
        editing,
        plan?.context,
      );
    } catch (error) {
      if (!(error instanceof PromptBudgetError)) throw error;
      // Refused before any provider starts: a settled failure the controller can name, not a crash.
      writeResult(run, { status: 'failed', reply: null, usage: null, error: error.message, refused: 'prompt_budget' });
      return;
    }
    if (turn.coverage)
      store.appendExecution(execution.id, 'implementation.context_captured', {
        artifact: snapshot.artifact,
        ...turn.coverage,
      });
    // Retain the actual prepared prompt, including repository context, rather than only its base request.
    if (
      !sessions.event(session.id, run.id, {
        type: 'prompt.prepared',
        data: { prompt: turn.prompt, artifact: snapshot.artifact },
      })
    )
      throw new Error('Native implementation no longer owns prompt preparation');
    const lost = () => new Error('Native implementation no longer owns an active turn');
    const output = new OutputBuffer(text => {
      if (!sessions.delta(session.id, run.id, text)) throw lost();
    });
    agent = await measurePhase(store, execution.id, 'provider_startup', () =>
      connectAgent(session.provider, {
        cwd: session.cwd,
        configurationCwd: workspaces.get(execution.workspaceId).repository,
        providerSessionId: session.providerSessionId,
        model: session.model,
        ...(session.effort ? { effort: session.effort } : {}),
        // Never aborted in this process: a stop ends the worker through its supervisor.
        signal: new AbortController().signal,
        editing,
        ...(commands?.available ? { commands } : {}),
        ...((!workspace && turn.exploration) || plan?.references?.length
          ? {
              repository: {
                repo: session.cwd,
                snapshot,
                references: plan?.references ?? [],
                checks: taskCheckEvidence(store, execution),
                currentChecks: () => taskCheckEvidence(store, execution),
                editable: [...run.policy.files, ...(run.policy.create ?? []), ...(run.policy.delete ?? [])],
                ...(run.policy.directories ? { directories: run.policy.directories } : {}),
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
      }),
    );
    const connected = agent;
    const turning: Promise<TurnResult> = measurePhase(store, execution.id, 'provider_turn', () =>
      connected.turn(turn.prompt),
    );
    // The last streamed text is journaled before the result exists, so it precedes settlement. A lost
    // run's flush fails like its other events would; the controller's settlement decides what counts.
    const result = await turning.finally(() => {
      try {
        output.flush();
      } catch {
        /* Display-only text. */
      }
    });
    await commands?.settlePending();
    await measurePhase(store, execution.id, 'provider_shutdown', () => connected.close());
    agent = null;
    if (result.status === 'completed' && result.reply?.kind !== 'question') await commands?.finish();
    writeResult(run, result);
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
