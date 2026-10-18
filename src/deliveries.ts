import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { Sessions } from './sessions.js';
import { Workspaces } from './workspaces.js';
import { claimExecution, type Execution, type ExecutionLease } from './execution-state.js';
import { captureRepository } from './repository-evidence.js';
import { allocateReceipt, readReceipt, requireDeadController, type CheckReceipt } from './check-recovery.js';
import { runCheckProcess, retainedOutput, type CheckProcessOptions, type CheckProcessResult } from './check-process.js';
import { gitText, verifyCommit, verifyNoChange, type DeliveryRequest } from './delivery-git.js';

export interface DeliverySpec { artifact: string; instructionsDigest: string; message: string; timeoutMs: number; mode?: 'commit' | 'no_change' }
export interface Delivery {
  id: string; executionId: string; spec: DeliverySpec;
  phase: 'running' | 'delivered' | 'failed' | 'interrupted' | 'recovery_required';
  dispatch: 'not_requested' | 'requested'; request: DeliveryRequest | null;
  receipt: CheckReceipt | null; supervisorPid: number | null; toolPid: number | null;
  result: CheckProcessResult | null; commit: string | null; error: string | null;
  outcome?: 'committed' | 'no_change' | null; // Older journals omit this until settlement.
}

export class Deliveries {
  constructor(private readonly store: Store, private readonly workspaces = new Workspaces(store)) {}
  get(id: string): Delivery { return this.store.delivery<Delivery>(id); }
  private save(delivery: Delivery, type: string): void {
    const execution = this.store.execution<Execution>(delivery.executionId);
    this.store.saveDelivery(delivery.id, execution.id, delivery);
    const event = { deliveryId: delivery.id, executionId: execution.id, phase: delivery.phase, dispatch: delivery.dispatch,
      spec: delivery.spec, parent: delivery.request?.snapshot.head ?? null, commit: delivery.commit, error: delivery.error,
      outcome: delivery.outcome,
      supervisorPid: delivery.supervisorPid, toolPid: delivery.toolPid, result: delivery.result };
    this.store.appendExecution(execution.id, type, event);
    this.store.append(execution.taskId, execution.version, type, event);
  }
  private fence(delivery: Delivery): Execution {
    const execution = this.store.execution<Execution>(delivery.executionId);
    const lease = this.store.lease<ExecutionLease>(execution.workspaceId);
    if (lease?.kind !== 'delivery' || lease.executionId !== execution.id || lease.runId !== delivery.id) throw new Error('Delivery no longer owns the workspace');
    return execution;
  }
  private settle(delivery: Delivery): void {
    this.store.transaction(() => {
      const execution = this.fence(delivery);
      delivery.outcome = null;
      if (delivery.phase === 'delivered') delivery.outcome = delivery.request?.mode === 'no_change' ? 'no_change' : 'committed';
      this.store.releaseLease(execution.workspaceId, execution.id, delivery.id);
      if (delivery.phase === 'delivered') new Workflow(this.store).complete(execution.taskId);
      this.save(delivery, 'delivery.settled');
    });
  }
  private async verify(delivery: Delivery): Promise<void> {
    const execution = this.fence(delivery); const request = delivery.request!;
    const snapshot = await captureRepository(this.workspaces, execution);
    const noChange = request.mode === 'no_change';
    let commit: string | null = null;
    if (noChange) verifyNoChange(request);
    else commit = verifyCommit(request);
    if ((noChange && snapshot.artifact !== request.snapshot.artifact)
      || snapshot.head !== (commit ?? request.snapshot.head) || snapshot.instructionsDigest !== request.snapshot.instructionsDigest
      || JSON.stringify(snapshot.files) !== JSON.stringify(request.snapshot.files)) throw new Error('Working files or instructions changed since the checked artifact');
    // Bound both Git inspection and content inspection to the same observed commit.
    const again = await captureRepository(this.workspaces, execution);
    if (again.artifact !== snapshot.artifact) throw new Error('Repository changed while verifying delivery');
    delivery.commit = commit;
  }
  async run(executionId: string, spec: DeliverySpec, signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess): Promise<Delivery> {
    spec = structuredClone(spec);
    if (!spec || Object.keys(spec).some(key => !['artifact', 'instructionsDigest', 'message', 'timeoutMs', 'mode'].includes(key))
      || (spec.mode !== undefined && !['commit', 'no_change'].includes(spec.mode))
      || typeof spec.artifact !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(spec.artifact)
      || typeof spec.instructionsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(spec.instructionsDigest)
      || typeof spec.message !== 'string' || !spec.message.trim() || spec.message.includes('\0') || /Grampus-Delivery:/i.test(spec.message)
      || Buffer.byteLength(spec.message) > 8192 || !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 100 || spec.timeoutMs > 600_000) {
      throw new Error('Delivery requires artifact, instructionsDigest, message (1–8192 bytes, no reserved marker), timeoutMs (100–600000) and optional mode (commit or no_change)');
    }
    if (process.platform !== 'win32') throw new Error('Supervised delivery currently requires Windows');
    const delivery: Delivery = { id: randomUUID(), executionId, spec, phase: 'running', dispatch: 'not_requested', request: null,
      receipt: null, supervisorPid: null, toolPid: null, result: null, commit: null, error: null, outcome: null };
    const execution = this.store.transaction(() => {
      const execution = this.store.execution<Execution>(executionId);
      const workflow = new Workflow(this.store); const task = workflow.get(execution.taskId);
      if (execution.role !== 'implementation') throw new Error('Delivery requires an implementation execution');
      const blockers = workflow.blockers(task.id);
      if (blockers.length || task.phase === 'complete' || task.attempt?.artifact !== spec.artifact) throw new Error(`Delivery requires the current submitted artifact and every gate: ${blockers.join('; ')}`);
      const session = new Sessions(this.store).get(execution.sessionId);
      if (session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase)) throw new Error('Reconcile the linked session first');
      claimExecution(this.store, session, delivery.id, 'delivery');
      this.save(delivery, 'delivery.requested'); return execution;
    });
    try {
      const snapshot = await captureRepository(this.workspaces, execution);
      if (snapshot.artifact !== spec.artifact || snapshot.instructionsDigest !== spec.instructionsDigest) throw new Error('Repository or instructions changed before delivery');
      const workspace = this.workspaces.get(execution.workspaceId);
      const branch = gitText(workspace.path!, 'symbolic-ref', 'HEAD');
      if (branch !== `refs/heads/${workspace.branch}`) throw new Error('Delivery branch differs from workspace ownership');
      delivery.request = { id: delivery.id, cwd: workspace.path!, branch, base: workspace.baseCommit, message: spec.message, snapshot };
      if (spec.mode !== undefined) delivery.request.mode = spec.mode;
      if (workspace.adapter === 'orca') {
        if (this.store.path === ':memory:' || !workspace.orca?.identityKey) throw new Error('Orca delivery requires a durable journal and known workspace identity');
        delivery.request.orca = { database: this.store.path, executionId, workspaceId: workspace.id, identityKey: workspace.orca.identityKey };
      }
      delivery.receipt = allocateReceipt(this.store, delivery.id);
      const requestFile = join(delivery.receipt.directory, 'delivery.json'); writeFileSync(requestFile, JSON.stringify(delivery.request));
      this.store.transaction(() => { this.fence(delivery); delivery.dispatch = 'requested'; this.save(delivery, 'delivery.dispatched'); });
      delivery.result = await runner({ file: process.execPath, args: [fileURLToPath(new URL('./delivery-worker.js', import.meta.url)), requestFile], cwd: workspace.path!,
        timeoutMs: spec.timeoutMs, ...(signal ? { signal } : {}), receipt: delivery.receipt,
        started: (kind, pid) => this.store.transaction(() => { this.fence(delivery); if (kind === 'supervisor') delivery.supervisorPid = pid; else delivery.toolPid = pid; this.save(delivery, 'delivery.process_started'); }) });
      if (!delivery.result.exitConfirmed) throw new Error('Delivery process exit is unconfirmed');
      if (delivery.result.reason === 'exited' && delivery.result.exitCode === 0) {
        await this.verify(delivery); delivery.phase = 'delivered';
      } else {
        delivery.phase = delivery.result.reason === 'interrupted' ? 'interrupted' : 'failed';
        delivery.error = 'Delivery command did not succeed; staged changes or an unaccepted commit may remain. No retry or rollback was performed.';
      }
      this.settle(delivery);
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      if (delivery.dispatch === 'not_requested' || delivery.result?.exitConfirmed) {
        delivery.phase = 'failed'; this.settle(delivery);
      } else {
        delivery.phase = 'recovery_required'; this.store.transaction(() => { this.fence(delivery); this.save(delivery, 'delivery.recovery_required'); });
      }
    }
    return this.get(delivery.id);
  }

  async recover(id: string): Promise<Delivery> {
    const delivery = this.get(id);
    this.store.transaction(() => {
      if (!['running', 'recovery_required'].includes(delivery.phase)) throw new Error('Delivery does not need recovery');
      const execution = this.fence(delivery); const lease = this.store.lease<ExecutionLease>(execution.workspaceId)!;
      requireDeadController(lease);
      if (delivery.dispatch === 'requested') {
        if (!delivery.receipt) throw new Error('Dispatched delivery has no settlement receipt identity');
        delivery.result = { ...readReceipt(delivery.receipt, delivery.supervisorPid, delivery.toolPid), ...retainedOutput(delivery.receipt.directory) };
      }
      this.store.releaseLease(execution.workspaceId, execution.id, id);
      this.store.acquireLease(execution.workspaceId, execution.id, id, { ...lease, controllerPid: process.pid });
      this.save(delivery, 'delivery.recovery_started');
    });
    try {
      if (delivery.result?.reason === 'exited' && delivery.result.exitCode === 0) {
        await this.verify(delivery); delivery.phase = 'delivered'; delivery.error = null;
      } else {
        delivery.phase = 'interrupted'; delivery.error = 'Recovered settled operation without accepting delivery; inspect index and HEAD before starting fresh work';
      }
    } catch (error) { delivery.phase = 'failed'; delivery.error = error instanceof Error ? error.message : String(error); }
    this.settle(delivery); return this.get(id);
  }
}
