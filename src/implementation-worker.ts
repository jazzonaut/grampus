import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { Workspaces } from './workspaces.js';
import { captureRepository, repositoryContext } from './repository-evidence.js';
import { Workflow } from './workflow.js';
import type { ImplementationRequest, ImplementationRun } from './implementations.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import { editingFileContext, prepareEditing } from './edit-policy.js';
import { connectAgent } from './agents/index.js';
import type { AgentSession, TurnResult } from './agents/types.js';

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ImplementationRequest;
  const store = new Store(request.database); let agent: AgentSession | null = null;
  try {
    const run = store.implementation<ImplementationRun>(request.id); const execution = store.execution<Execution>(run.executionId);
    const sessions = new Sessions(store); const session = sessions.get(execution.sessionId);
    if (store.lease<ExecutionLease>(execution.workspaceId)?.runId !== run.id || session.run?.id !== run.id || session.phase !== 'running') throw new Error('Native implementation ownership changed');
    const workspaces = new Workspaces(store); const snapshot = await captureRepository(workspaces, execution);
    const editing = { cwd: session.cwd, policy: run.policy, snapshot }; prepareEditing(editing);
    const plan = new Workflow(store).get(execution.taskId).guided?.plan;
    const context = plan?.context;
    const fileContext = session.provider === 'codex' ? `\nCurrent editable file contents (deferred entries must be read with grampus_read_file before editing; null without deferred means absent):\n${editingFileContext(editing, context?.exploration === true)}` : '';
    const selected = context?.files;
    const supplied = selected ? repositoryContext(session.cwd, snapshot, selected, context?.exploration === true) : null;
    if (supplied) store.appendExecution(execution.id, 'implementation.context_captured', { artifact: snapshot.artifact, ...supplied.coverage });
    agent = await connectAgent(session.provider, { cwd: session.cwd, configurationCwd: workspaces.get(execution.workspaceId).repository, providerSessionId: session.providerSessionId, model: session.model,
      signal: new AbortController().signal, editing, ...(context?.exploration ? { repository: { repo: session.cwd, snapshot, references: plan?.references ?? [], editable: [...run.policy.files, ...(run.policy.create ?? []), ...(run.policy.delete ?? [])] } } : {}), emit: event => {
        const current = sessions.get(session.id);
        if (current.phase !== 'running' || !sessions.event(session.id, run.id, event)) throw new Error('Native implementation no longer owns an active turn');
      } });
    const result: TurnResult = await agent.turn(`${request.prompt}\n\nAuthorized existing editable files: ${JSON.stringify(run.policy.files)}\nAuthorized new files (existing parent directories only): ${JSON.stringify(run.policy.create ?? [])}\nAuthorized deletion-only files (unchanged snapshot bytes): ${JSON.stringify(run.policy.delete ?? [])}\n${supplied ? `Starting repository context (read-only supporting files; does not expand editing permission). ${context?.exploration ? 'Use repository exploration tools to inspect dependencies, callers and tests beyond these initial files.' : 'Omitted files have not been supplied; ask for missing dependencies instead of guessing.'}:\n${JSON.stringify(supplied)}` : `Snapshot file count: ${snapshot.files.length}`}\nRepository instructions (apply within the explicit tool policy):\n${JSON.stringify(snapshot.instructions)}${fileContext}`);
    await agent.close(); agent = null;
    const path = join(run.receipt!.directory, 'result.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ id: run.id, result })); renameSync(`${path}.tmp`, path);
  } finally { try { await agent?.close(); } finally { store.close(); } }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
