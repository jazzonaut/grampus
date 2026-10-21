// Owns repository checks and the controller operations that bind evidence to an implementation's artifact:
// running approved commands under the supervisor, explicit quality assessments, submission and completion.
// Each operation holds the workspace lease under its own run id. A dispatched command is never rerun:
// without a confirmed exit it stays `recovery_required` until a terminal receipt settles it.
import { randomUUID } from 'node:crypto';
import { validateCheck } from './check-spec.js';
import type { Store } from '../persistence/store.js';
import type { CheckSpec, RepositoryCheck } from '../persistence/records.js';
import { commandLimits, formatBytes, planLimits } from '../config/limits.js';
import { Sessions } from '../execution/sessions.js';
import { Workflow, activeCriteria } from '../domain/workflow.js';
import { Workspaces } from '../repository/workspaces.js';
import { claimExecution, type Execution, type ExecutionLease } from '../execution/execution-state.js';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import {
  runCheckProcess,
  retainedOutput,
  type CheckProcessOptions,
  type CheckProcessResult,
} from '../process/check-process.js';
import { allocateReceipt, readReceipt, requireDeadController } from './check-recovery.js';
import { captureRepository } from '../repository/repository-evidence.js';
import { assertAcceptance } from '../domain/acceptance.js';
import { prepareEditing, verifyEditingScope } from '../execution/edit-policy.js';
import { lensOutcome, parseQualityAssessment, type QualityAssessment } from '../domain/quality-passes.js';
import { pendingReadiness } from '../domain/readiness.js';
import { checkInputFingerprint } from './check-inputs.js';
import { reusableDiagnostic } from './check-reuse.js';
import { recoverCheckGroup } from './check-group-recovery.js';
import { currentSettings } from '../config/settings.js';
import { restoreFingerprint, reusableRestore } from './restore-reuse.js';
import { measurePhase, measureSyncPhase } from '../execution/phase-timing.js';
import {
  diagnosticObservationGroup,
  checkObservationCaptures,
  type CheckObservationGroup,
} from './diagnostic-observations.js';

export type { CheckSpec, RepositoryCheck } from '../persistence/records.js';
export type { QualityAssessment } from '../domain/quality-passes.js';

/** Child checks retain their parent's lease instead of owning an independently releasable lease. */
function checkLease(check: RepositoryCheck): string {
  return check.groupId ?? check.implementationId ?? check.id;
}

/**
 * Controller-side checks and evidence operations on an implementation execution. Every operation
 * claims the workspace lease under a fresh run id and fences each journaled effect on it, so a process
 * that has lost the lease can never record a result.
 */
export class Checks {
  constructor(
    private readonly store: Store,
    private readonly workspaces = new Workspaces(store),
  ) {}
  get(id: string): RepositoryCheck {
    return this.store.check(id);
  }

  /** Claims the execution's workspace; the linked session must be idle so no provider turn shares it. */
  private claim(executionId: string, runId: string, kind: ExecutionLease['kind']): Execution {
    const execution = this.store.execution(executionId);
    const session = new Sessions(this.store).get(execution.sessionId);
    if (session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase))
      throw new Error('Reconcile the linked session first');
    claimExecution(this.store, session, runId, kind);
    return execution;
  }

  /** The workspace lease this run still holds; throws when it holds none. */
  private fenced(execution: Execution, runId: string): ExecutionLease {
    const lease = this.store.lease(execution.workspaceId);
    if (lease?.executionId !== execution.id || lease.runId !== runId)
      throw new Error('Check no longer owns the workspace lease');
    return lease;
  }

  private release(execution: Execution, runId: string): void {
    this.fenced(execution, runId);
    this.store.releaseLease(execution.workspaceId, execution.id, runId);
    this.store.appendExecution(execution.id, 'lease.released', { runId });
  }

  private async capture(execution: Execution): Promise<RepositorySnapshot> {
    return measurePhase(this.store, execution.id, 'snapshot', () => captureRepository(this.workspaces, execution));
  }

  /**
   * Captures the execution's workspace under a `snapshot` lease, so no turn or check changes it during the
   * capture. The capture only reads, so the lease is released on every exit path (and is marked
   * for read-only recovery if this process dies first).
   */
  async snapshot(executionId: string): Promise<RepositorySnapshot> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'snapshot'));
    try {
      return await this.capture(execution);
    } finally {
      this.store.transaction(() => this.release(execution, runId));
    }
  }

  /**
   * Records a trusted caller's assessment of one quality lens, not an inference from checks or review
   * findings. With `reviewId` it must repeat that settled review's own verdict for the lens exactly.
   * Skipped evidence for the lens is recorded first, so an earlier pass cannot satisfy the gate while this
   * one is pending; the result is recorded only if the workspace still holds the submitted artifact and
   * digests the caller named.
   *
   * @throws Error when the assessment is malformed, the execution is not the implementation, the review
   *   does not match, the attempt is not submitted, or the repository changed.
   */
  async assess(executionId: string, input: QualityAssessment): Promise<void> {
    const assessment = parseQualityAssessment(
      input,
      `A quality assessment requires a pass id, artifact, instructionsDigest, outcome (passed/failed/skipped) and a nonempty summary (at most ${formatBytes(commandLimits.assessmentBytes)})`,
    );
    const runId = randomUUID();
    const execution = this.store.transaction(() => {
      const execution = this.store.execution(executionId);
      if (execution.role !== 'implementation') throw new Error('Assess quality through the implementation execution');
      const task = this.store.get(execution.taskId);
      if (assessment.reviewId) {
        const review = this.store.execution(assessment.reviewId),
          session = new Sessions(this.store).get(review.sessionId);
        const verdict = session.lastReply?.lenses?.find(item => item.lens === assessment.pass);
        if (
          review.taskId !== execution.taskId ||
          review.version !== execution.version ||
          review.attemptId !== execution.attemptId ||
          review.role !== 'review' ||
          review.artifact !== assessment.artifact ||
          session.run ||
          session.phase !== 'idle' ||
          !verdict ||
          lensOutcome(verdict.verdict) !== assessment.outcome ||
          verdict.summary !== assessment.summary
        )
          throw new Error('A reviewer assessment must match a settled independent review of this artifact');
      }
      if (
        task.attempt?.outcome !== 'succeeded' ||
        !['awaiting_verification', 'awaiting_decision'].includes(task.phase)
      ) {
        throw new Error('Quality assessment requires a submitted implementation');
      }
      // `Workflow.record` refuses while the task holds a lease, so the pending marker precedes the claim.
      new Workflow(this.store).record(task.id, {
        id: `${runId}:requested`,
        attemptId: execution.attemptId,
        version: execution.version,
        artifact: task.attempt?.artifact ?? '',
        kind: 'quality',
        pass: assessment.pass,
        outcome: 'skipped',
        source: 'controller',
        summary: 'Explicit quality assessment requested; artifact verification is pending',
      });
      return this.claim(executionId, runId, 'assessment');
    });
    try {
      const snapshot = await this.capture(execution);
      if (
        snapshot.artifact !== assessment.artifact ||
        snapshot.instructionsDigest !== assessment.instructionsDigest ||
        snapshot.artifact !== this.store.get(execution.taskId).attempt?.artifact
      ) {
        throw new Error('Repository or instructions changed; assess the submitted artifact again');
      }
      // Release first for the same reason; one transaction keeps release and evidence together.
      this.store.transaction(() => {
        this.release(execution, runId);
        if (
          !new Workflow(this.store).record(execution.taskId, {
            id: runId,
            attemptId: execution.attemptId,
            version: execution.version,
            artifact: snapshot.artifact,
            kind: 'quality',
            pass: assessment.pass,
            source: assessment.reviewId ? 'agent' : 'controller',
            outcome: assessment.outcome,
            summary: assessment.summary,
          })
        ) {
          throw new Error('Implementation attempt changed before quality assessment');
        }
        this.store.appendExecution(execution.id, 'quality.assessed', assessment);
      });
    } finally {
      // On failure the lease is still ours; the read-only capture leaves nothing to recover.
      this.store.transaction(() => {
        if (this.store.lease(execution.workspaceId)?.runId === runId) this.release(execution, runId);
      });
    }
  }

  /**
   * Runs an approved command against the execution's current artifact under the check supervisor and
   * records the result. The kind follows from the spec: `preparation` (with a file scope), acceptance
   * `verification` (with criteria) or ordinary `validation`. A check passes only on a confirmed exit 0
   * with unchanged inputs (or changes within a preparation scope) and, for acceptance, every
   * observation matching. A dispatched check whose exit is unconfirmed is left `recovery_required`.
   * `runner` is injectable for tests; only the real supervisor is limited to Windows.
   *
   * @throws Error when the spec is invalid, the host is unsupported, or the request cannot claim the
   *   workspace. Failures after the request are recorded on the returned check instead.
   */
  async run(
    executionId: string,
    spec: CheckSpec,
    signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
  ): Promise<RepositoryCheck> {
    spec = structuredClone(spec);
    validateCheck(spec);
    // Reject unsupported hosts before acquiring ownership, even for an otherwise valid check.
    if (runner === runCheckProcess && process.platform !== 'win32')
      throw new Error('Repository checks currently require Windows 10 or later');
    const id = randomUUID();
    const purpose = spec.preparation
      ? 'preparation'
      : spec.criteria
        ? 'verification'
        : spec.readiness
          ? 'readiness'
          : 'validation';
    const execution = this.request(executionId, spec, id, purpose);
    const check = this.get(id);
    const dispatched = await this.observe(execution, check, signal, runner);
    return this.settle(execution, check, dispatched, signal);
  }

  /**
   * Runs explicitly independent readiness checks under one durable group lease. All requests precede
   * dispatch; every child has its own receipt. One uncertain child retains ownership of the entire group.
   */
  async readinessGroup(
    executionId: string,
    specs: CheckSpec[],
    signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
  ): Promise<RepositoryCheck[]> {
    if (
      !specs.length ||
      specs.length > planLimits.readinessChecks ||
      specs.some(spec => !spec.readiness || spec.preparation || spec.criteria)
    )
      throw new Error('A readiness group requires independent mechanical checks');
    specs.forEach(validateCheck);
    const first = specs[0];
    if (!first) throw new Error('Readiness group is empty');
    const groupId = randomUUID();
    const execution = this.store.transaction(() => {
      const execution = this.request(executionId, first, groupId, 'readiness');
      for (const [index, spec] of specs.entries()) {
        const check = { ...this.get(groupId), id: index === 0 ? groupId : randomUUID(), spec, groupId };
        this.store.saveCheck(check.id, executionId, check);
        if (index) {
          this.store.appendExecution(executionId, 'check.requested', { checkId: check.id, groupId, spec });
          this.store.append(execution.taskId, execution.version, 'check.requested', {
            executionId,
            checkId: check.id,
            groupId,
            spec,
          });
        }
      }
      this.store.appendExecution(executionId, 'check.group_requested', { groupId, specs });
      return execution;
    });
    const children = this.store.checks(executionId).filter(check => check.groupId === groupId);
    const queue = [...children];
    let stopScheduling = false;
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(children.length, currentSettings().maxReadinessConcurrency) }, async () => {
        while (!stopScheduling) {
          const check = queue.shift();
          if (!check) return;
          try {
            const dispatched = await this.observe(execution, check, signal, runner);
            const result = this.settle(execution, check, dispatched, signal);
            if (result.phase === 'recovery_required') stopScheduling = true;
          } catch (error) {
            stopScheduling = true;
            throw error;
          }
        }
      }),
    );
    this.store.transaction(() => {
      this.fenced(execution, groupId);
      if (
        outcomes.every(outcome => outcome.status === 'fulfilled') &&
        children.every(check => !['running', 'recovery_required'].includes(this.get(check.id).phase))
      )
        this.release(execution, groupId);
    });
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    return children.map(check => this.get(check.id));
  }

  /**
   * Runs an implementation diagnostic under its existing lease. It never supplies acceptance or
   * readiness evidence, and it cannot release the implementation's lease while its provider runs.
   * A captured input may come only from scope validation in this same suspended-write operation;
   * the after-image is always freshly observed. Recovery never supplies this optimisation.
   */
  async duringImplementation(
    implementationId: string,
    spec: CheckSpec,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
    captured?: RepositorySnapshot,
  ): Promise<RepositoryCheck> {
    const checks = await this.duringImplementationGroup(implementationId, [spec], 1, runner, captured);
    const check = checks[0];
    if (!check) throw new Error('Implementation diagnostic result is missing');
    return check;
  }

  /** Reserves every child before dispatch; uncertain children remain owned by the parent implementation. */
  async duringImplementationGroup(
    implementationId: string,
    specs: CheckSpec[],
    concurrency: number,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
    captured?: RepositorySnapshot,
  ): Promise<RepositoryCheck[]> {
    if (!specs.length || specs.length > planLimits.readinessChecks || !Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('Invalid implementation diagnostic group');
    for (const spec of specs) {
      validateCheck(spec);
      if (spec.criteria || spec.readiness || (specs.length > 1 && spec.preparation))
        throw new Error('Implementation diagnostics cannot supply gate evidence or concurrent preparation');
    }
    const children = specs.map(spec => ({ id: randomUUID(), spec: structuredClone(spec) }));
    const execution = this.store.transaction(() => {
      const run = this.store.implementation(implementationId);
      const execution = this.store.execution(run.executionId);
      this.fenced(execution, implementationId);
      const session = this.store.session(execution.sessionId);
      if (run.phase !== 'running' || session.run?.id !== implementationId || session.phase !== 'running')
        throw new Error('Implementation diagnostic requires an active owned turn');
      if (
        this.store
          .checks(execution.id)
          .some(
            check =>
              check.implementationId === implementationId && ['running', 'recovery_required'].includes(check.phase),
          )
      )
        throw new Error('An implementation command is still unsettled');
      for (const { id, spec } of children) {
        const check: RepositoryCheck = {
          id,
          executionId: execution.id,
          implementationId,
          spec: structuredClone(spec),
          phase: 'running',
          before: null,
          after: null,
          supervisorPid: null,
          toolPid: null,
          result: null,
          error: null,
          purpose: spec.preparation ? 'preparation' : 'validation',
          dispatch: 'not_requested',
        };
        this.store.saveCheck(id, execution.id, check);
        this.store.appendExecution(execution.id, 'check.requested', { checkId: id, implementationId, spec });
        this.store.append(execution.taskId, execution.version, 'check.requested', {
          executionId: execution.id,
          checkId: id,
          implementationId,
          spec,
        });
      }
      return execution;
    });
    const ceiling = Math.min(concurrency, children.length, currentSettings().maxReadinessConcurrency);
    for (let offset = 0; offset < children.length; offset += ceiling) {
      const batch = children.slice(offset, offset + ceiling).map(child => this.get(child.id));
      await this.observeImplementationBatch(execution, batch, runner, offset === 0 ? captured : undefined);
      if (batch.some(check => this.get(check.id).phase === 'recovery_required')) break;
    }
    return children.map(child => this.get(child.id));
  }

  private async observeImplementationBatch(
    execution: Execution,
    batch: RepositoryCheck[],
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult>,
    captured?: RepositorySnapshot,
  ): Promise<void> {
    let group: CheckObservationGroup | undefined;
    if (batch.length > 1) group = await diagnosticObservationGroup(() => this.capture(execution), batch, captured);
    else if (captured) group = { before: captured, after: () => this.capture(execution), settled: () => {} };
    const outcomes = await Promise.allSettled(
      batch.map(async check => {
        const dispatched = await this.observe(execution, check, undefined, runner, group);
        this.settle(execution, check, dispatched, undefined);
      }),
    );
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }

  /** Reconciles child commands before releasing their parent, without replay or accepting lost success. */
  reconcileImplementation(implementationId: string): boolean {
    const run = this.store.implementation(implementationId);
    const execution = this.store.execution(run.executionId);
    return this.store.transaction(() => {
      this.fenced(execution, implementationId);
      for (const check of this.store
        .checks(execution.id)
        .filter(
          check =>
            check.implementationId === implementationId && ['running', 'recovery_required'].includes(check.phase),
        )) {
        if (check.dispatch === 'requested') {
          if (!check.receipt) return false;
          try {
            check.result = {
              ...readReceipt(check.receipt, check.supervisorPid, check.toolPid),
              ...retainedOutput(check.receipt.directory),
            };
          } catch {
            return false;
          }
          if (!check.result.exitConfirmed) return false;
        }
        check.phase = 'interrupted';
        check.error =
          'Parent implementation settled before this command; reconciled without replay or success acceptance';
        this.store.saveCheck(check.id, execution.id, check);
        this.store.appendExecution(execution.id, 'check.recovered', {
          checkId: check.id,
          implementationId,
          acceptedAsSuccess: false,
        });
      }
      return true;
    });
  }

  /**
   * Claims the workspace and journals the check request. An acceptance check first records skipped
   * verification evidence under its name, so an earlier pass of the same check cannot satisfy the gate
   * while this one is pending, and
   * must map exactly the current slice's criteria.
   */
  private request(executionId: string, spec: CheckSpec, id: string, purpose: RepositoryCheck['purpose']): Execution {
    return this.store.transaction(() => {
      // `Workflow.record` refuses while the task holds a lease, so the pending marker precedes the claim.
      if (purpose === 'verification') {
        const execution = this.store.execution(executionId);
        const task = this.store.get(execution.taskId);
        new Workflow(this.store).record(task.id, {
          id: `${id}:requested`,
          attemptId: execution.attemptId,
          version: execution.version,
          artifact: task.attempt?.artifact ?? '',
          kind: 'verification',
          outcome: 'skipped',
          source: 'controller',
          criteria: spec.criteria ?? [],
          check: spec.name,
          summary: 'Acceptance check requested; a new verified result is pending',
        });
      }
      const execution = this.claim(executionId, id, purpose === 'verification' ? 'verification' : 'check');
      if (execution.role !== 'implementation')
        throw new Error('Repository checks currently require an implementation execution');
      const task = this.store.get(execution.taskId);
      if (
        purpose === 'verification' &&
        (task.attempt?.outcome !== 'succeeded' ||
          !['awaiting_verification', 'awaiting_decision'].includes(task.phase) ||
          (spec.criteria ?? []).length !== activeCriteria(task).length ||
          !activeCriteria(task).every(item => (spec.criteria ?? []).includes(item)))
      ) {
        throw new Error(
          'Verification requires submitted implementation and an exact mapping of all approved criteria for the current slice',
        );
      }
      const check: RepositoryCheck = {
        id,
        executionId,
        spec: structuredClone(spec),
        phase: 'running',
        before: null,
        after: null,
        supervisorPid: null,
        toolPid: null,
        result: null,
        error: null,
        purpose,
        dispatch: 'not_requested',
      };
      this.store.saveCheck(id, executionId, check);
      this.store.appendExecution(executionId, 'check.requested', { checkId: id, spec });
      this.store.append(execution.taskId, execution.version, 'check.requested', { executionId, checkId: id, spec });
      return execution;
    });
  }

  /**
   * Snapshots, dispatches and observes the check, recording any failure as the check's error rather
   * than throwing. Returns whether the command was dispatched, which decides whether an unknown
   * result can still settle.
   */
  private async observe(
    execution: Execution,
    check: RepositoryCheck,
    signal: AbortSignal | undefined,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult>,
    group?: CheckObservationGroup,
  ): Promise<boolean> {
    const { id, executionId, spec } = check;
    const purpose = check.purpose;
    const captures = checkObservationCaptures(() => this.capture(execution), group);
    let dispatched = false;
    try {
      check.before = await captures.before();
      if (check.before.artifact !== spec.artifact || check.before.instructionsDigest !== spec.instructionsDigest)
        throw new Error('Repository or instructions changed; inspect a fresh snapshot before dispatch');
      this.captureInputs(execution, check, 'before');
      if (spec.preparation?.scope)
        prepareEditing({
          cwd: this.workspaces.path(execution.workspaceId),
          snapshot: check.before,
          policy: { ...spec.preparation.scope, artifact: spec.artifact, instructionsDigest: spec.instructionsDigest },
        });
      if (purpose === 'verification' && check.before.artifact !== this.store.get(execution.taskId).attempt?.artifact)
        throw new Error('Repository changed since implementation submission');
      if (signal?.aborted) {
        check.result = {
          reason: 'interrupted',
          exitCode: null,
          exitConfirmed: true,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        };
      } else if (this.adoptRestore(execution, check) || this.adoptDiagnostic(execution, check)) {
        // This gate has its own durable request and settlement, but no process is dispatched twice.
      } else {
        // Dispatch boundary: the receipt identity and `dispatch: 'requested'` are durable before the
        // runner starts, so recovery knows a command may have run and demands a matching receipt.
        const receipt = (check.receipt = allocateReceipt(this.store, id));
        this.store.transaction(() => {
          this.fenced(execution, checkLease(check));
          check.dispatch = 'requested';
          this.store.saveCheck(id, executionId, check);
          this.store.appendExecution(executionId, 'check.dispatch_requested', {
            checkId: id,
            artifact: check.before?.artifact,
          });
        });
        dispatched = true;
        check.result = await measurePhase(this.store, executionId, 'command', () =>
          runner({
            file: spec.file,
            args: spec.args,
            cwd: this.workspaces.path(execution.workspaceId),
            timeoutMs: spec.timeoutMs,
            receipt,
            ...(signal ? { signal } : {}),
            // Recorded PIDs let recovery match the receipt to these exact processes.
            started: (kind, pid) => {
              this.store.transaction(() => {
                this.fenced(execution, checkLease(check));
                if (kind === 'supervisor') check.supervisorPid = pid;
                else check.toolPid = pid;
                this.store.saveCheck(id, executionId, check);
                this.store.appendExecution(executionId, 'check.process_started', { checkId: id, kind, pid });
              });
            },
          }),
        );
      }
      // The after-snapshot is only meaningful once nothing in the job can still write.
      captures.settled(check);
      if (check.result?.exitConfirmed) {
        check.after = await captures.after();
        this.captureInputs(execution, check, 'after');
        if (spec.preparation?.scope)
          verifyEditingScope(
            {
              cwd: this.workspaces.path(execution.workspaceId),
              snapshot: check.before,
              policy: {
                ...spec.preparation.scope,
                artifact: spec.artifact,
                instructionsDigest: spec.instructionsDigest,
              },
            },
            check.after,
          );
        else if (check.before.artifact !== check.after.artifact)
          check.error = 'Check changed repository inputs; inspect the diff and run a fresh check';
        this.inspectAcceptance(check);
      }
    } catch (error) {
      check.error = error instanceof Error ? error.message : String(error);
    } finally {
      captures.settled(check);
    }
    return dispatched;
  }

  private inspectAcceptance(check: RepositoryCheck): void {
    if (check.purpose !== 'verification' || !check.after || !check.result) return;
    try {
      assertAcceptance(check.after, check.result, check.spec.expectedStdout, check.spec.expectations);
    } catch (error) {
      check.failureKind = 'acceptance';
      throw error;
    }
  }

  /** Adopts only a completed parent run from this execution, under the new gate's workspace lease. */
  private adoptDiagnostic(execution: Execution, check: RepositoryCheck): boolean {
    if (!check.spec.reuse || check.implementationId || check.spec.preparation) return false;
    const source = reusableDiagnostic(this.store.checks(execution.id), check, check.inputFingerprint?.before ?? null);
    if (
      !source?.implementationId ||
      !source.result ||
      this.store.implementation(source.implementationId).phase !== 'completed'
    ) {
      this.store.appendExecution(execution.id, 'check.reuse_missed', {
        checkId: check.id,
        kind: 'diagnostic',
        reason: check.inputFingerprint?.before ? 'no_matching_trusted_diagnostic' : 'inputs_unknown',
      });
      return false;
    }
    check.reusedFrom = source.id;
    check.result = { ...source.result, elapsedMs: 0 };
    return true;
  }

  /** Captures optional inputs; a missing fingerprint disables reuse rather than turning unknown into success. */
  private captureInputs(execution: Execution, check: RepositoryCheck, side: 'before' | 'after'): void {
    if (check.spec.restore)
      measureSyncPhase(this.store, execution.id, 'input_fingerprint', () =>
        restoreFingerprint(this.workspaces.path(execution.workspaceId), check, side),
      );
    if (side === 'after' && check.spec.restore && check.reusedFrom) {
      const source = this.store.check(check.reusedFrom);
      if (
        check.restoreFingerprint?.before !== check.restoreFingerprint?.after ||
        check.restoreFingerprint?.outputs !== source.restoreFingerprint?.outputs
      )
        check.error = 'Restore inputs or outputs changed during adoption; run a fresh restore';
    }
    const reuse = check.spec.reuse;
    if (!reuse) return;
    const fingerprint = measureSyncPhase(this.store, execution.id, 'input_fingerprint', () =>
      checkInputFingerprint(this.workspaces.path(execution.workspaceId), check.spec.file, reuse.inputs),
    );
    check.inputFingerprint ??= { before: null, after: null };
    check.inputFingerprint[side] = fingerprint;
    if (side === 'after' && check.reusedFrom && fingerprint !== check.inputFingerprint.before)
      check.error = 'Reusable check inputs changed during adoption; run a fresh check';
  }

  private adoptRestore(execution: Execution, check: RepositoryCheck): boolean {
    if (!check.spec.restore) return false;
    const source = reusableRestore(this.store, execution, check, this.workspaces.path(execution.workspaceId));
    if (!source?.result) {
      this.store.appendExecution(execution.id, 'check.reuse_missed', {
        checkId: check.id,
        kind: 'restore',
        reason: check.restoreFingerprint?.before ? 'no_matching_trusted_restore' : 'inputs_unknown',
      });
      return false;
    }
    check.reusedFrom = source.id;
    check.result = { ...source.result, elapsedMs: 0 };
    return true;
  }

  /**
   * Settles the check in one transaction. Without a confirmed exit the lease is kept and the attempt
   * becomes uncertain (except for acceptance, whose attempt has already been submitted), so nothing
   * runs again until explicit recovery.
   */
  private settle(
    execution: Execution,
    check: RepositoryCheck,
    dispatched: boolean,
    signal: AbortSignal | undefined,
  ): RepositoryCheck {
    const { id, executionId, purpose } = check;
    return this.store.transaction(() => {
      this.fenced(execution, checkLease(check));
      // No result before dispatch means nothing ran; no result after dispatch means the outcome is unknown.
      const confirmed = check.result?.exitConfirmed ?? !dispatched;
      check.phase = !confirmed
        ? 'recovery_required'
        : signal?.aborted || check.result?.reason === 'interrupted'
          ? 'interrupted'
          : !check.error && check.result?.reason === 'exited' && check.result.exitCode === 0
            ? 'passed'
            : 'failed';
      if (confirmed && !check.implementationId && !check.groupId) this.release(execution, id);
      this.markUncertain(execution, check, confirmed);
      this.store.saveCheck(id, executionId, check);
      const event = {
        checkId: id,
        phase: check.phase,
        artifact: check.before?.artifact,
        result: check.result,
        error: check.error,
      };
      this.store.appendExecution(executionId, 'check.settled', event);
      this.store.append(execution.taskId, execution.version, 'check.settled', event);
      this.recordReuse(check);
      if (confirmed && purpose === 'verification') this.recordVerification(execution, check);
      return check;
    });
  }

  private recordReuse(check: RepositoryCheck): void {
    if (!check.reusedFrom) return;
    this.store.appendExecution(check.executionId, 'check.reused', {
      checkId: check.id,
      sourceCheckId: check.reusedFrom,
      savedMs: this.store.check(check.reusedFrom).result?.elapsedMs ?? null,
    });
  }

  /**
   * Records acceptance evidence for a settled check against the submitted artifact; an interrupted check
   * counts as skipped. Call after the lease is released, since `Workflow.record` refuses while it is held.
   */
  private recordVerification(execution: Execution, check: RepositoryCheck): void {
    const task = this.store.get(execution.taskId);
    const artifact = task.attempt?.artifact;
    if (!artifact) throw new Error('Verification requires a submitted artifact');
    new Workflow(this.store).record(task.id, {
      id: check.id,
      attemptId: execution.attemptId,
      version: execution.version,
      artifact,
      kind: 'verification',
      source: 'controller',
      outcome: check.phase === 'passed' ? 'passed' : check.phase === 'interrupted' ? 'skipped' : 'failed',
      criteria: check.spec.criteria ?? [],
      check: check.spec.name,
      summary: `Acceptance check ${check.spec.name}: ${check.phase}. Output/file expectations and criterion mapping supplied by the caller; command and actual result retained in check ${check.id}.`,
    });
  }

  /** Parent implementations own recovery of their child commands; standalone checks own the attempt. */
  private markUncertain(execution: Execution, check: RepositoryCheck, confirmed: boolean): void {
    if (confirmed || check.purpose === 'verification' || check.implementationId) return;
    const task = this.store.get(execution.taskId);
    task.phase = 'recovery_required';
    if (!task.attempt) throw new Error('Check task has no current attempt');
    task.attempt.outcome = 'uncertain';
    this.store.save(task.id, task);
  }

  /**
   * Explicit recovery of a check whose controller died or whose exit was unconfirmed. It never reruns the
   * command and never accepts a lost success: the check always ends `interrupted`. A check that never
   * reached dispatch is released directly; a dispatched one needs a matching terminal receipt, whose
   * result and retained output are adopted for the record only. A non-acceptance attempt made uncertain
   * by the check returns to running (or stopped, if a stop was requested).
   *
   * @throws Error when the check does not hold its lease or need recovery, the controller is alive or on
   *   another host, the receipt is missing or does not match, or the task binding changed.
   */
  recover(id: string): RepositoryCheck {
    if (this.get(id).groupId) return recoverCheckGroup(this.store, id);
    return this.store.transaction(() => {
      const check = this.get(id);
      const execution = this.store.execution(check.executionId);
      const lease = this.fenced(execution, id);
      if (!['check', 'verification'].includes(lease.kind) || !['running', 'recovery_required'].includes(check.phase))
        throw new Error('Check does not need recovery');
      requireDeadController(lease);
      if (check.dispatch === 'requested') {
        if (!check.receipt) throw new Error('Dispatched check has no settlement receipt identity; ownership retained');
        check.result = {
          ...readReceipt(check.receipt, check.supervisorPid, check.toolPid),
          ...retainedOutput(check.receipt.directory),
        };
      }
      check.phase = 'interrupted';
      check.error = 'Recovered without replay or success acceptance; run an explicit fresh check';
      this.release(execution, id);
      const task = this.store.get(execution.taskId);
      if (task.attempt?.id !== execution.attemptId || task.version !== execution.version)
        throw new Error('Recovery task binding changed');
      if (check.purpose !== 'verification' && task.phase === 'recovery_required') {
        task.phase = 'running';
        task.attempt.outcome = 'running';
        this.store.save(task.id, task);
      }
      if (check.purpose !== 'verification' && task.phase === 'stop_requested') {
        task.phase = 'stopped';
        task.attempt.outcome = 'stopped';
        this.store.save(task.id, task);
      }
      this.store.saveCheck(id, execution.id, check);
      const event = {
        checkId: id,
        dispatch: check.dispatch,
        phase: check.phase,
        result: check.result,
        replayed: false,
        acceptedAsSuccess: false,
      };
      this.store.appendExecution(execution.id, 'check.recovered', event);
      this.store.append(task.id, task.version, 'check.recovered', event);
      if (check.purpose === 'verification') this.recordVerification(execution, check);
      return check;
    });
  }

  /**
   * Completes the task once its gates are satisfied, after proving the workspace still holds the submitted
   * artifact. Throws when the repository changed or `Workflow.complete` reports blockers.
   */
  async complete(executionId: string): Promise<void> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'completion'));
    try {
      if (execution.role !== 'implementation') throw new Error('Complete through the implementation execution');
      const snapshot = await this.capture(execution);
      this.store.transaction(() => {
        if (snapshot.artifact !== this.store.get(execution.taskId).attempt?.artifact)
          throw new Error('Repository changed since implementation submission');
        this.release(execution, runId);
        new Workflow(this.store).complete(execution.taskId);
        this.store.appendExecution(execution.id, 'artifact.completed', { artifact: snapshot.artifact });
      });
    } finally {
      this.store.transaction(() => {
        if (this.store.lease(execution.workspaceId)?.runId === runId) this.release(execution, runId);
      });
    }
  }

  /**
   * Explicit caller decision: implementation is ready; one passing check only supplies validation. The
   * check must be this execution's latest, so a newer failure cannot be bypassed, and the workspace must
   * still match its after-snapshot. Submission and validation evidence settle with the lease release.
   *
   * @throws Error when the check is not an eligible passing check, the repository changed, or the attempt
   *   changed before submission.
   */
  async finish(executionId: string, checkId: string): Promise<void> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'submission'));
    try {
      const check = this.get(checkId);
      if (
        execution.role !== 'implementation' ||
        check.executionId !== executionId ||
        check.phase !== 'passed' ||
        !check.after ||
        check.purpose === 'preparation'
      )
        throw new Error('Finish requires a passing check from this implementation; preparation is not validation');
      if (check.purpose === 'readiness') throw new Error('Readiness cannot substitute for behavioural validation');
      const latest = this.store.checks(executionId).at(-1);
      if (latest?.id !== checkId)
        throw new Error('Use the latest check; newer failed or interrupted checks cannot be bypassed');
      const snapshot = await this.capture(execution);
      if (snapshot.artifact !== check.after.artifact)
        throw new Error('Repository changed after the check; run it again');
      const guided = this.store.get(execution.taskId).guided;
      const slice = guided?.plan.slices[execution.sliceIndex];
      if (guided && !slice) throw new Error('The implementation has no approved slice');
      if (slice && pendingReadiness(slice.readiness, snapshot, this.store.checks(executionId)))
        throw new Error('Every approved readiness check must pass on this artifact before submission');
      this.store.transaction(() => {
        this.release(execution, runId);
        const workflow = new Workflow(this.store);
        if (
          !workflow.finish(
            execution.taskId,
            execution.attemptId,
            execution.version,
            'succeeded',
            snapshot.artifact,
            'Implementation submitted with verified repository content and a passing command',
          )
        )
          throw new Error('Implementation attempt changed before submission');
        workflow.record(execution.taskId, {
          id: check.id,
          attemptId: execution.attemptId,
          version: execution.version,
          artifact: snapshot.artifact,
          kind: 'validation',
          outcome: 'passed',
          source: 'controller',
          summary: `Check ${check.spec.name} exited 0 with unchanged repository content; see check ${check.id}`,
        });
        this.store.appendExecution(executionId, 'implementation.submitted', { checkId, artifact: snapshot.artifact });
      });
    } finally {
      this.store.transaction(() => {
        if (this.store.lease(execution.workspaceId)?.runId === runId) this.release(execution, runId);
      });
    }
  }
}
