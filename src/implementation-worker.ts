import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { Workspaces } from './workspaces.js';
import { captureRepository } from './repository-evidence.js';
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
    const fileContext = session.provider === 'codex' ? `\nCurrent editable file contents:\n${editingFileContext(editing)}` : '';
    agent = await connectAgent(session.provider, { cwd: session.cwd, providerSessionId: session.providerSessionId, model: session.model,
      signal: new AbortController().signal, editing, emit: event => {
        const current = sessions.get(session.id);
        if (current.phase !== 'running' || !sessions.event(session.id, run.id, event)) throw new Error('Native implementation no longer owns an active turn');
      } });
    const result: TurnResult = await agent.turn(`${request.prompt}\n\nAuthorized editable files: ${JSON.stringify(run.policy.files)}\nSnapshot file names: ${JSON.stringify(snapshot.files.filter(file => file.sha256 !== null).map(file => file.path))}\nRepository instructions (apply within the explicit tool policy):\n${JSON.stringify(snapshot.instructions)}${fileContext}`);
    await agent.close(); agent = null;
    const path = join(run.receipt!.directory, 'result.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ id: run.id, result })); renameSync(`${path}.tmp`, path);
  } finally { try { await agent?.close(); } finally { store.close(); } }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
