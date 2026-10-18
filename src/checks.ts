import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { Workflow, activeCriteria, type Task } from './workflow.js';
import { Workspaces } from './workspaces.js';
import { claimExecution, type Execution, type ExecutionLease } from './execution-state.js';
import type { RepositorySnapshot } from './artifacts.js';
import { runCheckProcess, retainedOutput, type CheckProcessOptions, type CheckProcessResult } from './check-process.js';
import { allocateReceipt, readReceipt, requireDeadController, type CheckReceipt } from './check-recovery.js';
import { captureRepository } from './repository-evidence.js';

export interface CheckSpec {
  name: string;
  file: string;
  args: string[];
  timeoutMs: number;
  artifact: string;
  instructionsDigest: string;
  criteria?: string[];
  expectedStdout?: string;
}
export interface SimplificationAssessment {
  artifact: string;
  instructionsDigest: string;
  outcome: 'passed' | 'failed' | 'skipped';
  summary: string;
}
export interface RepositoryCheck {
  id: string;
  executionId: string;
  phase: 'running' | 'passed' | 'failed' | 'interrupted' | 'recovery_required';
  spec: CheckSpec;
  before: RepositorySnapshot | null;
  after: RepositorySnapshot | null;
  supervisorPid: number | null;
  toolPid: number | null;
  result: CheckProcessResult | null;
  error: string | null;
  purpose?: 'validation' | 'verification';
  dispatch?: 'not_requested' | 'requested';
  receipt?: CheckReceipt;
}

function validate(spec: CheckSpec): void {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 200) throw new Error('Check name is required (at most 200 characters)');
  if (Object.keys(spec).some(key => !['name', 'file', 'args', 'timeoutMs', 'artifact', 'instructionsDigest', 'criteria', 'expectedStdout'].includes(key))) throw new Error('Unknown check option');
  if (spec.criteria !== undefined && (!Array.isArray(spec.criteria) || spec.criteria.length === 0
    || spec.criteria.some(value => typeof value !== 'string' || !value.trim()) || new Set(spec.criteria).size !== spec.criteria.length)) throw new Error('Verification requires distinct acceptance criteria');
  if (spec.criteria !== undefined ? typeof spec.expectedStdout !== 'string' || Buffer.byteLength(spec.expectedStdout) > 64 * 1024 : spec.expectedStdout !== undefined) {
    throw new Error('Verification requires expectedStdout (at most 64 KiB); ordinary checks do not accept output assertions');
  }
  if (typeof spec.file !== 'string' || !isAbsolute(spec.file) || !statSync(spec.file).isFile()
    || (process.platform === 'win32' && !spec.file.toLowerCase().endsWith('.exe'))) throw new Error('Check file must be an absolute executable path; invoke scripts through their interpreter');
  if (!Array.isArray(spec.args) || spec.args.some(value => typeof value !== 'string' || value.includes('\0')) || spec.file.includes('\0')) throw new Error('Check arguments must be strings without NUL');
  if (JSON.stringify(spec.args).length > 24_000) throw new Error('Check arguments exceed the current limit');
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 100 || spec.timeoutMs > 600_000) throw new Error('Check timeout must be between 100 and 600000 ms');
  if (typeof spec.artifact !== 'string' || typeof spec.instructionsDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(spec.artifact) || !/^[a-f0-9]{64}$/.test(spec.instructionsDigest)) throw new Error('Copy artifact and instructionsDigest from a current execution snapshot');
}

export class Checks {
  constructor(private readonly store: Store, private readonly workspaces = new Workspaces(store)) {}
  get(id: string): RepositoryCheck { return this.store.check<RepositoryCheck>(id); }

  private claim(executionId: string, runId: string, kind: NonNullable<ExecutionLease['kind']>): Execution {
    const execution = this.store.execution<Execution>(executionId);
    const session = new Sessions(this.store).get(execution.sessionId);
    if (session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase)) throw new Error('Reconcile the linked session first');
    claimExecution(this.store, session, runId, kind);
    return execution;
  }

  private fenced(execution: Execution, runId: string): void {
    const lease = this.store.lease<ExecutionLease>(execution.workspaceId);
    if (lease?.executionId !== execution.id || lease.runId !== runId) throw new Error('Check no longer owns the workspace lease');
  }

  private release(execution: Execution, runId: string): void {
    this.fenced(execution, runId);
    this.store.releaseLease(execution.workspaceId, execution.id, runId);
    this.store.appendExecution(execution.id, 'lease.released', { runId });
  }

  private async capture(execution: Execution): Promise<RepositorySnapshot> {
    return captureRepository(this.workspaces, execution);
  }

  async snapshot(executionId: string): Promise<RepositorySnapshot> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'snapshot'));
    try { return await this.capture(execution); }
    finally { this.store.transaction(() => this.release(execution, runId)); }
  }

  /** A trusted caller's assessment, not an inference from checks or review findings. */
  async simplify(executionId: string, assessment: SimplificationAssessment): Promise<void> {
    assessment = structuredClone(assessment);
    if (!assessment || Object.keys(assessment).some(key => !['artifact', 'instructionsDigest', 'outcome', 'summary'].includes(key))
      || typeof assessment.artifact !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(assessment.artifact)
      || typeof assessment.instructionsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(assessment.instructionsDigest)
      || !['passed', 'failed', 'skipped'].includes(assessment.outcome)
      || typeof assessment.summary !== 'string' || !assessment.summary.trim() || Buffer.byteLength(assessment.summary) > 16 * 1024) {
      throw new Error('Simplification requires artifact, instructionsDigest, outcome (passed/failed/skipped) and a nonempty summary (at most 16 KiB)');
    }
    const runId = randomUUID();
    const execution = this.store.transaction(() => {
      const execution = this.store.execution<Execution>(executionId);
      if (execution.role !== 'implementation') throw new Error('Assess simplification through the implementation execution');
      const task = this.store.get<Task>(execution.taskId);
      if (task.attempt?.outcome !== 'succeeded' || !['awaiting_verification', 'awaiting_decision'].includes(task.phase)) {
        throw new Error('Simplification assessment requires a submitted implementation');
      }
      new Workflow(this.store).record(task.id, { id: `${runId}:requested`, attemptId: execution.attemptId, version: execution.version,
        artifact: task.attempt?.artifact ?? '', kind: 'simplification', outcome: 'skipped', source: 'controller',
        summary: 'Explicit simplification assessment requested; artifact verification is pending' });
      return this.claim(executionId, runId, 'simplification');
    });
    try {
      const snapshot = await this.capture(execution);
      if (snapshot.artifact !== assessment.artifact || snapshot.instructionsDigest !== assessment.instructionsDigest
        || snapshot.artifact !== this.store.get<Task>(execution.taskId).attempt?.artifact) {
        throw new Error('Repository or instructions changed; assess the submitted artifact again');
      }
      this.store.transaction(() => {
        this.release(execution, runId);
        if (!new Workflow(this.store).record(execution.taskId, { id: runId, attemptId: execution.attemptId, version: execution.version,
          artifact: snapshot.artifact, kind: 'simplification', source: 'controller', outcome: assessment.outcome, summary: assessment.summary })) {
          throw new Error('Implementation attempt changed before simplification assessment');
        }
        this.store.appendExecution(execution.id, 'simplification.assessed', assessment);
      });
    } finally {
      this.store.transaction(() => { if (this.store.lease<ExecutionLease>(execution.workspaceId)?.runId === runId) this.release(execution, runId); });
    }
  }

  async run(executionId: string, spec: CheckSpec, signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess): Promise<RepositoryCheck> {
    spec = structuredClone(spec);
    validate(spec);
    // Reject unsupported hosts before acquiring ownership, even for an otherwise valid check.
    if (runner === runCheckProcess && process.platform !== 'win32') throw new Error('Repository checks currently require Windows 10 or later');
    const id = randomUUID();
    const purpose = spec.criteria ? 'verification' : 'validation';
    const execution = this.store.transaction(() => {
      if (purpose === 'verification') {
        const execution = this.store.execution<Execution>(executionId);
        const task = this.store.get<Task>(execution.taskId);
        new Workflow(this.store).record(task.id, { id: `${id}:requested`, attemptId: execution.attemptId, version: execution.version, artifact: task.attempt?.artifact ?? '',
          kind: 'verification', outcome: 'skipped', source: 'controller', criteria: spec.criteria!, summary: 'Acceptance check requested; a new verified result is pending' });
      }
      const execution = this.claim(executionId, id, purpose === 'verification' ? 'verification' : 'check');
      if (execution.role !== 'implementation') throw new Error('Repository checks currently require an implementation execution');
      const task = this.store.get<Task>(execution.taskId);
      if (purpose === 'verification' && (task.attempt?.outcome !== 'succeeded' || !['awaiting_verification', 'awaiting_decision'].includes(task.phase)
        || spec.criteria!.length !== activeCriteria(task).length || !activeCriteria(task).every(item => spec.criteria!.includes(item)))) {
        throw new Error('Verification requires submitted implementation and an exact mapping of all approved criteria for the current slice');
      }
      const check: RepositoryCheck = { id, executionId, spec: structuredClone(spec), phase: 'running', before: null, after: null,
        supervisorPid: null, toolPid: null, result: null, error: null, purpose, dispatch: 'not_requested' };
      this.store.saveCheck(id, executionId, check);
      this.store.appendExecution(executionId, 'check.requested', { checkId: id, spec });
      this.store.append(execution.taskId, execution.version, 'check.requested', { executionId, checkId: id, spec });
      return execution;
    });
    let dispatched = false;
    const check = this.get(id);
    try {
      check.before = await this.capture(execution);
      if (check.before.artifact !== spec.artifact || check.before.instructionsDigest !== spec.instructionsDigest) throw new Error('Repository or instructions changed; inspect a fresh snapshot before dispatch');
      if (purpose === 'verification' && check.before.artifact !== this.store.get<Task>(execution.taskId).attempt?.artifact) throw new Error('Repository changed since implementation submission');
      if (signal?.aborted) {
        check.result = { reason: 'interrupted', exitCode: null, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
      } else {
        check.receipt = allocateReceipt(this.store, id);
        this.store.transaction(() => {
          this.fenced(execution, id);
          check.dispatch = 'requested';
          this.store.saveCheck(id, executionId, check);
          this.store.appendExecution(executionId, 'check.dispatch_requested', { checkId: id, artifact: check.before!.artifact });
        });
        dispatched = true;
        check.result = await runner({ file: spec.file, args: spec.args, cwd: this.workspaces.get(execution.workspaceId).path!, timeoutMs: spec.timeoutMs,
          receipt: check.receipt,
          ...(signal ? { signal } : {}), started: (kind, pid) => {
            this.store.transaction(() => {
              this.fenced(execution, id);
              if (kind === 'supervisor') check.supervisorPid = pid; else check.toolPid = pid;
              this.store.saveCheck(id, executionId, check);
              this.store.appendExecution(executionId, 'check.process_started', { checkId: id, kind, pid });
            });
          } });
      }
      if (check.result.exitConfirmed) {
        check.after = await this.capture(execution);
        if (check.before.artifact !== check.after.artifact) check.error = 'Check changed repository inputs; inspect the diff and run a fresh check';
        if (purpose === 'verification' && (check.result.outputTruncated || check.result.outputUnavailable || check.result.stdout !== spec.expectedStdout)) {
          check.error = 'Acceptance output did not exactly match expectedStdout, or retained output was truncated/unavailable';
        }
      }
    } catch (error) { check.error = error instanceof Error ? error.message : String(error); }
    return this.store.transaction(() => {
      this.fenced(execution, id);
      const confirmed = check.result?.exitConfirmed ?? !dispatched;
      check.phase = !confirmed ? 'recovery_required' : signal?.aborted || check.result?.reason === 'interrupted' ? 'interrupted'
        : !check.error && check.result?.reason === 'exited' && check.result.exitCode === 0 ? 'passed' : 'failed';
      if (confirmed) this.release(execution, id);
      else if (purpose === 'validation') {
        const task = this.store.get<Task>(execution.taskId);
        task.phase = 'recovery_required'; task.attempt!.outcome = 'uncertain';
        this.store.save(task.id, task);
      }
      this.store.saveCheck(id, executionId, check);
      const event = { checkId: id, phase: check.phase, artifact: check.before?.artifact, result: check.result, error: check.error };
      this.store.appendExecution(executionId, 'check.settled', event);
      this.store.append(execution.taskId, execution.version, 'check.settled', event);
      if (confirmed && purpose === 'verification') this.recordVerification(execution, check);
      return check;
    });
  }

  private recordVerification(execution: Execution, check: RepositoryCheck): void {
    const task = this.store.get<Task>(execution.taskId);
    new Workflow(this.store).record(task.id, { id: check.id, attemptId: execution.attemptId, version: execution.version, artifact: task.attempt!.artifact!,
      kind: 'verification', source: 'controller', outcome: check.phase === 'passed' ? 'passed' : check.phase === 'interrupted' ? 'skipped' : 'failed',
      criteria: check.spec.criteria!, summary: `Acceptance check ${check.spec.name}: ${check.phase}. Exact output expectation and criterion mapping supplied by the caller; command and actual result retained in check ${check.id}.` });
  }

  recover(id: string): RepositoryCheck {
    return this.store.transaction(() => {
      const check = this.get(id); const execution = this.store.execution<Execution>(check.executionId);
      this.fenced(execution, id);
      const lease = this.store.lease<ExecutionLease>(execution.workspaceId)!;
      if (!['check', 'verification'].includes(lease.kind ?? '') || !['running', 'recovery_required'].includes(check.phase)) throw new Error('Check does not need recovery');
      requireDeadController(lease);
      if (check.dispatch === 'requested' && check.receipt) {
        check.result = { ...readReceipt(check.receipt, check.supervisorPid, check.toolPid), ...retainedOutput(check.receipt.directory) };
      } else if (check.dispatch !== 'not_requested') throw new Error('No durable dispatch boundary or matching completion receipt; ownership retained');
      check.phase = 'interrupted'; check.error = 'Recovered without replay or success acceptance; run an explicit fresh check';
      this.release(execution, id);
      const task = this.store.get<Task>(execution.taskId);
      if (task.attempt?.id !== execution.attemptId || task.version !== execution.version) throw new Error('Recovery task binding changed');
      if (check.purpose !== 'verification' && task.phase === 'recovery_required') { task.phase = 'running'; task.attempt.outcome = 'running'; this.store.save(task.id, task); }
      if (check.purpose !== 'verification' && task.phase === 'stop_requested') { task.phase = 'stopped'; task.attempt.outcome = 'stopped'; this.store.save(task.id, task); }
      this.store.saveCheck(id, execution.id, check);
      const event = { checkId: id, dispatch: check.dispatch, result: check.result, replayed: false, acceptedAsSuccess: false };
      this.store.appendExecution(execution.id, 'check.recovered', event);
      this.store.append(task.id, task.version, 'check.recovered', event);
      if (check.purpose === 'verification') this.recordVerification(execution, check);
      return check;
    });
  }

  async complete(executionId: string): Promise<void> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'completion'));
    try {
      if (execution.role !== 'implementation') throw new Error('Complete through the implementation execution');
      const snapshot = await this.capture(execution);
      this.store.transaction(() => {
        if (snapshot.artifact !== this.store.get<Task>(execution.taskId).attempt?.artifact) throw new Error('Repository changed since implementation submission');
        this.release(execution, runId);
        new Workflow(this.store).complete(execution.taskId);
        this.store.appendExecution(execution.id, 'artifact.completed', { artifact: snapshot.artifact });
      });
    } finally {
      this.store.transaction(() => { if (this.store.lease<ExecutionLease>(execution.workspaceId)?.runId === runId) this.release(execution, runId); });
    }
  }

  /** Explicit caller decision: implementation is ready; one passing check only supplies validation. */
  async finish(executionId: string, checkId: string): Promise<void> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'submission'));
    try {
      const check = this.get(checkId);
      if (execution.role !== 'implementation' || check.executionId !== executionId || check.phase !== 'passed' || !check.after) throw new Error('Finish requires a passing check from this implementation');
      const latest = this.store.checks<RepositoryCheck>(executionId).at(-1);
      if (latest?.id !== checkId) throw new Error('Use the latest check; newer failed or interrupted checks cannot be bypassed');
      const snapshot = await this.capture(execution);
      if (snapshot.artifact !== check.after.artifact) throw new Error('Repository changed after the check; run it again');
      this.store.transaction(() => {
        this.release(execution, runId);
        const workflow = new Workflow(this.store);
        if (!workflow.finish(execution.taskId, execution.attemptId, execution.version, 'succeeded', snapshot.artifact, 'Implementation submitted with verified repository content and a passing command')) throw new Error('Implementation attempt changed before submission');
        workflow.record(execution.taskId, { id: check.id, attemptId: execution.attemptId, version: execution.version, artifact: snapshot.artifact,
          kind: 'validation', outcome: 'passed', source: 'controller', summary: `Check ${check.spec.name} exited 0 with unchanged repository content; see check ${check.id}` });
        this.store.appendExecution(executionId, 'implementation.submitted', { checkId, artifact: snapshot.artifact });
      });
    } finally {
      this.store.transaction(() => {
        if (this.store.lease<ExecutionLease>(execution.workspaceId)?.runId === runId) this.release(execution, runId);
      });
    }
  }
}
