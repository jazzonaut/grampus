import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Sessions, type RunOptions } from './sessions.js';
import { Workspaces } from './workspaces.js';
import { captureRepository } from './repository-evidence.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import { prepareEditing, validateEditPolicy, verifyEditingScope, type EditPolicy, type EditingContext } from './edit-policy.js';
import { allocateReceipt, readReceipt, requireDeadController, type CheckReceipt } from './check-recovery.js';
import { runCheckProcess, retainedOutput, type CheckProcessOptions, type CheckProcessResult } from './check-process.js';
import { parseReply, type TurnResult } from './agents/types.js';
import type { RepositorySnapshot } from './artifacts.js';

export interface ImplementationRun {
  id: string; executionId: string; policy: EditPolicy;
  phase: 'running' | 'completed' | 'failed' | 'interrupted' | 'recovery_required';
  dispatch: 'not_requested' | 'requested'; before: RepositorySnapshot | null; after: RepositorySnapshot | null;
  receipt: CheckReceipt | null; supervisorPid: number | null; toolPid: number | null;
  process: CheckProcessResult | null; result: TurnResult | null; error: string | null;
}
export interface ImplementationRequest { database: string; id: string; prompt: string }

export class Implementations {
  constructor(private readonly store: Store, private readonly workspaces = new Workspaces(store)) {}
  get(id: string): ImplementationRun { return this.store.implementation<ImplementationRun>(id); }
  private fence(run: ImplementationRun): Execution {
    const execution = this.store.execution<Execution>(run.executionId); const lease = this.store.lease<ExecutionLease>(execution.workspaceId);
    if (lease?.kind !== 'implementation' || lease.executionId !== execution.id || lease.runId !== run.id) throw new Error('Implementation no longer owns its workspace');
    return execution;
  }
  private save(run: ImplementationRun, type: string): void {
    const execution = this.fence(run);
    this.store.saveImplementation(run.id, execution.id, run);
    const event = { implementationId: run.id, phase: run.phase, dispatch: run.dispatch, policy: run.policy,
      before: run.before?.artifact ?? null, after: run.after?.artifact ?? null, error: run.error, process: run.process, result: run.result };
    this.store.appendExecution(execution.id, type, event); this.store.append(execution.taskId, execution.version, type, event);
  }
  private async settle(run: ImplementationRun, recovered = false): Promise<void> {
    const execution = this.fence(run); const sessions = new Sessions(this.store);
    const interrupted = sessions.get(execution.sessionId).phase === 'stop_requested' || run.process?.reason === 'interrupted' || recovered;
    let result: TurnResult = { status: interrupted ? 'interrupted' : 'failed', reply: null, usage: null,
      error: run.error ?? (run.process?.stderr.trim() || `Implementation did not return a confirmed result (${run.process?.reason ?? 'not dispatched'})`) };
    if (!interrupted && run.process?.reason === 'exited' && run.process.exitCode === 0 && run.receipt) {
      try {
        const response = JSON.parse(readFileSync(join(run.receipt.directory, 'result.json'), 'utf8')) as { id: string; result: TurnResult };
        if (response.id !== run.id || !['completed', 'failed', 'interrupted'].includes(response.result?.status)) throw new Error('Invalid implementation result');
        result = response.result;
        if (result.status === 'completed') result.reply = parseReply(result.reply);
      } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
    }
    if (run.before) {
      try {
        run.after = await captureRepository(this.workspaces, execution);
        verifyEditingScope({ cwd: this.workspaces.get(execution.workspaceId).path!, policy: run.policy, snapshot: run.before }, run.after);
      } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
    }
    if (run.error && !interrupted) result = { ...result, status: 'failed', reply: null, error: run.error };
    run.result = result; run.phase = result.status;
    this.store.transaction(() => {
      this.save(run, recovered ? 'implementation.recovered' : 'implementation.settled');
      sessions.settle(execution.sessionId, run.id, result, true);
    });
  }
  async run(executionId: string, policy: EditPolicy, prompt = 'Implement the approved task using the authorized files.',
    options: Pick<RunOptions, 'signal' | 'answers' | 'timeoutMs'> = {},
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess): Promise<ImplementationRun> {
    policy = structuredClone(policy); validateEditPolicy(policy);
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new Error('Implementation timeout must be 100–600000 ms');
    if (process.platform !== 'win32' || this.store.path === ':memory:') throw new Error('Native implementation requires Windows and a durable journal');
    const sessions = new Sessions(this.store); let claimedPrompt = '';
    const run = this.store.transaction(() => {
      const execution = this.store.execution<Execution>(executionId);
      if (execution.role !== 'implementation') throw new Error('Native implementation requires an implementation execution');
      const claim = sessions.claim(execution.sessionId, prompt, options.answers, true); claimedPrompt = claim.prompt;
      const run: ImplementationRun = { id: claim.runId, executionId, policy, phase: 'running', dispatch: 'not_requested', before: null, after: null,
        receipt: null, supervisorPid: null, toolPid: null, process: null, result: null, error: null };
      this.save(run, 'implementation.requested'); return run;
    });
    const execution = this.fence(run);
    const stop = () => sessions.stop(execution.sessionId, run.id, 'Native implementation interrupted; stopping supervised process tree');
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      run.before = await captureRepository(this.workspaces, execution);
      const context: EditingContext = { cwd: this.workspaces.get(execution.workspaceId).path!, policy, snapshot: run.before }; prepareEditing(context);
      if (options.signal?.aborted) throw new Error('Interrupted before native implementation dispatch');
      run.receipt = allocateReceipt(this.store, run.id);
      const requestFile = join(run.receipt.directory, 'implementation.json');
      writeFileSync(requestFile, JSON.stringify({ database: this.store.path, id: run.id, prompt: claimedPrompt } satisfies ImplementationRequest));
      this.store.transaction(() => { run.dispatch = 'requested'; this.save(run, 'implementation.dispatched'); });
      run.process = await runner({ file: process.execPath, args: [fileURLToPath(new URL('./implementation-worker.js', import.meta.url)), requestFile],
        cwd: context.cwd, timeoutMs, ...(options.signal ? { signal: options.signal } : {}), receipt: run.receipt,
        started: (kind, pid) => this.store.transaction(() => { if (kind === 'supervisor') run.supervisorPid = pid; else run.toolPid = pid; this.save(run, 'implementation.process_started'); }) });
    } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
    finally { options.signal?.removeEventListener('abort', stop); }
    if (run.dispatch === 'not_requested' || run.process?.exitConfirmed) await this.settle(run);
    else this.store.transaction(() => {
      run.phase = 'recovery_required'; this.save(run, 'implementation.recovery_required');
      sessions.settle(execution.sessionId, run.id, { status: 'failed', reply: null, usage: null, error: run.error ?? 'Native tool exit is unconfirmed' }, false);
    });
    return this.get(run.id);
  }
  async recover(id: string): Promise<ImplementationRun> {
    const run = this.get(id);
    this.store.transaction(() => {
      if (!['running', 'recovery_required'].includes(run.phase)) throw new Error('Implementation run does not need recovery');
      const execution = this.fence(run); const lease = this.store.lease<ExecutionLease>(execution.workspaceId)!; requireDeadController(lease);
      if (run.dispatch === 'requested') {
        if (!run.receipt) throw new Error('Implementation dispatch has no receipt identity');
        run.process = { ...readReceipt(run.receipt, run.supervisorPid, run.toolPid), ...retainedOutput(run.receipt.directory) };
      }
      this.store.releaseLease(execution.workspaceId, execution.id, run.id);
      this.store.acquireLease(execution.workspaceId, execution.id, run.id, { ...lease, controllerPid: process.pid });
      const session = new Sessions(this.store).get(execution.sessionId);
      if (session.run?.id !== run.id) throw new Error('Implementation session ownership changed');
      session.run.controllerPid = process.pid; session.phase = 'stop_requested'; this.store.saveSession(session.id, session);
      this.save(run, 'implementation.recovery_started');
    });
    await this.settle(run, true); return this.get(id);
  }
}
