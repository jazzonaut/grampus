// Owns local delivery: committing exactly the checked artifact (or verifying an unchanged head) through
// the supervised delivery worker, verifying the result against the retained request, and explicit
// recovery from supervisor proof. A delivery is dispatched once; it is never retried or rolled back.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../persistence/store.js';
import type { Delivery, DeliveryRequest, DeliverySpec } from '../persistence/records.js';
import { commandLimits, planLimits } from '../config/limits.js';
import { Workflow } from '../domain/workflow.js';
import { deepEqual } from '../domain/deep-equal.js';
import { Sessions } from './sessions.js';
import { Workspaces } from '../repository/workspaces.js';
import { claimExecution, type Execution } from './execution-state.js';
import { captureRepository } from '../repository/repository-evidence.js';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import { allocateReceipt, readReceipt, requireDeadController } from '../verification/check-recovery.js';
import {
  runCheckProcess,
  retainedOutput,
  type CheckProcessOptions,
  type CheckProcessResult,
} from '../process/check-process.js';
import { gitText, verifyCommit, verifyNoChange } from '../repository/delivery-git.js';
import { currentProcessStartedAt } from '../process/process-identity.js';

export type { Delivery, DeliverySpec } from '../persistence/records.js';

/** Whether a commit message is deliverable: bounded text without the marker Grampus adds itself. */
function validMessage(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    !!message.trim() &&
    !message.includes('\0') &&
    !/Grampus-Delivery:/i.test(message) &&
    Buffer.byteLength(message) <= planLimits.commitMessageBytes
  );
}

/** Throws unless `spec` names a current-format artifact and digest, a valid message, timeout and mode. */
function validateSpec(spec: DeliverySpec): void {
  if (
    !spec ||
    Object.keys(spec).some(key => !['artifact', 'instructionsDigest', 'message', 'timeoutMs', 'mode'].includes(key)) ||
    (spec.mode !== undefined && !['commit', 'no_change'].includes(spec.mode)) ||
    typeof spec.artifact !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(spec.artifact) ||
    typeof spec.instructionsDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(spec.instructionsDigest) ||
    !validMessage(spec.message) ||
    !Number.isSafeInteger(spec.timeoutMs) ||
    spec.timeoutMs < commandLimits.minTimeoutMs ||
    spec.timeoutMs > commandLimits.maxTimeoutMs
  ) {
    throw new Error(
      `Delivery requires artifact, instructionsDigest, message (1–${planLimits.commitMessageBytes} bytes, no reserved marker), timeoutMs (${commandLimits.minTimeoutMs}–${commandLimits.maxTimeoutMs}) and optional mode (commit or no_change)`,
    );
  }
}

/** A delivery that has claimed nothing yet. */
function newDelivery(executionId: string, spec: DeliverySpec): Delivery {
  return {
    id: randomUUID(),
    executionId,
    spec,
    phase: 'running',
    dispatch: 'not_requested',
    request: null,
    receipt: null,
    supervisorPid: null,
    toolPid: null,
    result: null,
    commit: null,
    error: null,
    outcome: null,
  };
}

/**
 * Local Git delivery of an implementation execution's checked artifact. A delivery's id doubles as the
 * run id of its `delivery` lease, so every journaled effect is fenced on the delivery itself.
 */
export class Deliveries {
  constructor(
    private readonly store: Store,
    private readonly workspaces = new Workspaces(store),
  ) {}
  get(id: string): Delivery {
    return this.store.delivery(id);
  }

  /** Saves the record and journals `type` on the execution and the task. */
  private save(delivery: Delivery, type: string): void {
    const execution = this.store.execution(delivery.executionId);
    this.store.saveDelivery(delivery.id, execution.id, delivery);
    const event = {
      deliveryId: delivery.id,
      executionId: execution.id,
      phase: delivery.phase,
      dispatch: delivery.dispatch,
      spec: delivery.spec,
      parent: delivery.request?.snapshot.head ?? null,
      commit: delivery.commit,
      error: delivery.error,
      outcome: delivery.outcome,
      supervisorPid: delivery.supervisorPid,
      toolPid: delivery.toolPid,
      result: delivery.result,
    };
    this.store.appendExecution(execution.id, type, event);
    this.store.append(execution.taskId, execution.version, type, event);
  }

  /** Throws unless this delivery still holds the workspace's delivery lease under its own run id. */
  private fence(delivery: Delivery): Execution {
    const execution = this.store.execution(delivery.executionId);
    const lease = this.store.lease(execution.workspaceId);
    if (lease?.kind !== 'delivery' || lease.executionId !== execution.id || lease.runId !== delivery.id)
      throw new Error('Delivery no longer owns the workspace');
    return execution;
  }

  /**
   * Releases the lease and journals the outcome in one transaction; a delivered result is accepted
   * into the task (the next slice or completion) in that same transaction.
   */
  private settle(delivery: Delivery): void {
    this.store.transaction(() => {
      const execution = this.fence(delivery);
      delivery.outcome = null;
      if (delivery.phase === 'delivered')
        delivery.outcome = delivery.request?.mode === 'no_change' ? 'no_change' : 'committed';
      this.store.releaseLease(execution.workspaceId, execution.id, delivery.id);
      this.save(delivery, 'delivery.settled');
      if (delivery.phase === 'delivered') new Workflow(this.store).acceptDelivery(execution.taskId, delivery.id);
    });
  }

  /**
   * Verifies the worker's result from Git and a fresh snapshot: the expected commit (or the unchanged
   * head) with exactly the checked files and instructions. The snapshot is taken twice so Git and
   * content inspection are bound to the same observed commit.
   */
  private async verify(delivery: Delivery): Promise<void> {
    const execution = this.fence(delivery);
    const request = delivery.request;
    if (!request) throw new Error('Delivery has no retained request to verify');
    const snapshot = await captureRepository(this.workspaces, execution);
    const noChange = request.mode === 'no_change';
    let commit: string | null = null;
    if (noChange) verifyNoChange(request);
    else commit = verifyCommit(request);
    if (
      (noChange && snapshot.artifact !== request.snapshot.artifact) ||
      snapshot.head !== (commit ?? request.snapshot.head) ||
      snapshot.instructionsDigest !== request.snapshot.instructionsDigest ||
      !deepEqual(snapshot.files, request.snapshot.files)
    )
      throw new Error('Working files or instructions changed since the checked artifact');
    const again = await captureRepository(this.workspaces, execution);
    if (again.artifact !== snapshot.artifact) throw new Error('Repository changed while verifying delivery');
    delivery.commit = commit;
  }

  /** Claims the workspace for the delivery after checking every gate of the current submitted artifact. */
  private claim(delivery: Delivery): Execution {
    return this.store.transaction(() => {
      const execution = this.store.execution(delivery.executionId);
      const workflow = new Workflow(this.store);
      const task = workflow.get(execution.taskId);
      if (execution.role !== 'implementation') throw new Error('Delivery requires an implementation execution');
      const blockers = workflow.sliceBlockers(task.id);
      if (blockers.length || task.phase === 'complete' || task.attempt?.artifact !== delivery.spec.artifact)
        throw new Error(`Delivery requires the current submitted artifact and every gate: ${blockers.join('; ')}`);
      const session = new Sessions(this.store).get(execution.sessionId);
      if (session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase))
        throw new Error('Reconcile the linked session first');
      claimExecution(this.store, session, delivery.id, 'delivery');
      this.save(delivery, 'delivery.requested');
      return execution;
    });
  }

  /**
   * The exact request the worker will execute, on the workspace's own branch, retained on the delivery.
   * An Orca workspace also names the journal and identity, so the worker can fence every Git write on
   * the live lease.
   */
  private request(delivery: Delivery, execution: Execution, snapshot: RepositorySnapshot): DeliveryRequest {
    const workspace = this.workspaces.get(execution.workspaceId);
    if (!workspace.path) throw new Error('Delivery workspace has no path');
    const cwd = workspace.path;
    const branch = gitText(cwd, 'symbolic-ref', 'HEAD');
    if (branch !== `refs/heads/${workspace.branch}`)
      throw new Error('Delivery branch differs from workspace ownership');
    const request: DeliveryRequest = {
      id: delivery.id,
      cwd,
      branch,
      base: workspace.baseCommit,
      message: delivery.spec.message,
      snapshot,
    };
    if (delivery.spec.mode !== undefined) request.mode = delivery.spec.mode;
    // Retained before the Orca checks, so a refused request is still recorded with the failed delivery.
    delivery.request = request;
    if (workspace.adapter === 'orca') {
      if (this.store.path === ':memory:' || !workspace.orca?.identityKey)
        throw new Error('Orca delivery requires a durable journal and known workspace identity');
      request.orca = {
        database: this.store.path,
        executionId: execution.id,
        workspaceId: workspace.id,
        identityKey: workspace.orca.identityKey,
      };
    }
    return request;
  }

  /**
   * Writes the request file, journals the dispatch boundary and runs the supervised worker. From the
   * dispatch boundary on, the delivery is never repeated: an unconfirmed exit needs recovery.
   */
  private async dispatch(
    delivery: Delivery,
    request: DeliveryRequest,
    signal: AbortSignal | undefined,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult>,
  ): Promise<CheckProcessResult> {
    const receipt = allocateReceipt(this.store, delivery.id);
    delivery.receipt = receipt;
    const requestFile = join(receipt.directory, 'delivery.json');
    writeFileSync(requestFile, JSON.stringify(request));
    // The dispatch boundary: once this commits, the worker may have run and is never started again.
    this.store.transaction(() => {
      this.fence(delivery);
      delivery.dispatch = 'requested';
      this.save(delivery, 'delivery.dispatched');
    });
    return runner({
      file: process.execPath,
      args: [fileURLToPath(new URL('./delivery-worker.js', import.meta.url)), requestFile],
      cwd: request.cwd,
      timeoutMs: delivery.spec.timeoutMs,
      ...(signal ? { signal } : {}),
      receipt,
      started: (kind, pid) =>
        this.store.transaction(() => {
          this.fence(delivery);
          if (kind === 'supervisor') delivery.supervisorPid = pid;
          else delivery.toolPid = pid;
          this.save(delivery, 'delivery.process_started');
        }),
    });
  }

  /**
   * Delivers the current submitted artifact of an implementation execution. Every gate must already
   * pass; the delivery is accepted into the task only after verification. Failures settle with the
   * reason, except a dispatched worker whose exit is unconfirmed, which stays `recovery_required`.
   *
   * @throws Error when the spec is invalid, the host is not Windows, or a gate or the lease claim
   *   refuses the delivery. Later failures are recorded on the returned delivery instead.
   */
  async run(
    executionId: string,
    spec: DeliverySpec,
    signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
  ): Promise<Delivery> {
    spec = structuredClone(spec);
    validateSpec(spec);
    if (process.platform !== 'win32') throw new Error('Supervised delivery currently requires Windows');
    const delivery = newDelivery(executionId, spec);
    const execution = this.claim(delivery);
    try {
      const snapshot = await captureRepository(this.workspaces, execution);
      if (snapshot.artifact !== spec.artifact || snapshot.instructionsDigest !== spec.instructionsDigest)
        throw new Error('Repository or instructions changed before delivery');
      const request = this.request(delivery, execution, snapshot);
      delivery.result = await this.dispatch(delivery, request, signal, runner);
      if (!delivery.result.exitConfirmed) throw new Error('Delivery process exit is unconfirmed');
      if (delivery.result.reason === 'exited' && delivery.result.exitCode === 0) {
        await this.verify(delivery);
        delivery.phase = 'delivered';
      } else {
        delivery.phase = delivery.result.reason === 'interrupted' ? 'interrupted' : 'failed';
        delivery.error =
          'Delivery command did not succeed; staged changes or an unaccepted commit may remain. No retry or rollback was performed.';
      }
      this.settle(delivery);
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      // Settle only when nothing was dispatched or the worker's exit is confirmed; otherwise a Git
      // write may still be in flight, so the lease is kept for explicit recovery.
      if (delivery.dispatch === 'not_requested' || delivery.result?.exitConfirmed) {
        delivery.phase = 'failed';
        this.settle(delivery);
      } else {
        delivery.phase = 'recovery_required';
        this.store.transaction(() => {
          this.fence(delivery);
          this.save(delivery, 'delivery.recovery_required');
        });
      }
    }
    return this.get(delivery.id);
  }

  /**
   * Recovers a delivery whose controller died, from the supervisor's settlement receipt. The lease is
   * taken over by this process, a successful worker result is verified exactly as in `run`, and the
   * worker is never started again. A delivery that never reached dispatch, or whose worker did not exit 0,
   * settles `interrupted` without being accepted.
   *
   * @throws Error when the delivery does not need recovery or no longer holds its lease, the controller is
   *   alive or on another host, or a dispatched delivery's receipt is missing or does not match. A failed
   *   verification is recorded on the returned delivery instead.
   */
  async recover(id: string): Promise<Delivery> {
    const delivery = this.get(id);
    this.store.transaction(() => {
      if (!['running', 'recovery_required'].includes(delivery.phase))
        throw new Error('Delivery does not need recovery');
      const execution = this.fence(delivery);
      const lease = this.store.lease(execution.workspaceId);
      if (!lease) throw new Error('Delivery no longer owns the workspace');
      requireDeadController(lease);
      if (delivery.dispatch === 'requested') {
        if (!delivery.receipt) throw new Error('Dispatched delivery has no settlement receipt identity');
        delivery.result = {
          ...readReceipt(delivery.receipt, delivery.supervisorPid, delivery.toolPid),
          ...retainedOutput(delivery.receipt.directory),
        };
      }
      // Take the lease over under the same run id with this controller's identity, so verification stays
      // fenced and a crash during it can itself be recovered.
      this.store.releaseLease(execution.workspaceId, execution.id, id);
      this.store.acquireLease(execution.workspaceId, execution.id, id, {
        ...lease,
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
      });
      this.save(delivery, 'delivery.recovery_started');
    });
    try {
      if (delivery.result?.reason === 'exited' && delivery.result.exitCode === 0) {
        await this.verify(delivery);
        delivery.phase = 'delivered';
        delivery.error = null;
      } else {
        delivery.phase = 'interrupted';
        delivery.error =
          'Recovered settled operation without accepting delivery; inspect index and HEAD before starting fresh work';
      }
    } catch (error) {
      delivery.phase = 'failed';
      delivery.error = error instanceof Error ? error.message : String(error);
    }
    this.settle(delivery);
    return this.get(id);
  }
}
