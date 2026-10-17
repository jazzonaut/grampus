import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { Workflow, type Task } from './workflow.js';
import { Workspaces } from './workspaces.js';
import { claimExecution, type Execution, type ExecutionLease } from './execution-state.js';
import { snapshotRepository, type RepositorySnapshot } from './artifacts.js';
import { runCheckProcess, type CheckProcessOptions, type CheckProcessResult } from './check-process.js';

export interface CheckSpec {
  name: string;
  file: string;
  args: string[];
  timeoutMs: number;
  artifact: string;
  instructionsDigest: string;
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
}

function validate(spec: CheckSpec): void {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 200) throw new Error('Check name is required (at most 200 characters)');
  if (Object.keys(spec).some(key => !['name', 'file', 'args', 'timeoutMs', 'artifact', 'instructionsDigest'].includes(key))) throw new Error('Unknown check option');
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
    const inspected = await this.workspaces.inspect(execution.workspaceId, false);
    if (!inspected.taskCurrent) throw new Error('Workspace task version changed');
    const workspace = this.workspaces.get(execution.workspaceId);
    const snapshot = await snapshotRepository(workspace.path!, workspace.baseCommit);
    // A second read detects changes during collection. The lease coordinates Grampus, not external editors.
    const verified = await snapshotRepository(workspace.path!, workspace.baseCommit);
    if (snapshot.artifact !== verified.artifact) throw new Error('Repository changed while collecting the snapshot');
    await this.workspaces.inspect(execution.workspaceId, false);
    return snapshot;
  }

  async snapshot(executionId: string): Promise<RepositorySnapshot> {
    const runId = randomUUID();
    const execution = this.store.transaction(() => this.claim(executionId, runId, 'snapshot'));
    try { return await this.capture(execution); }
    finally { this.store.transaction(() => this.release(execution, runId)); }
  }

  async run(executionId: string, spec: CheckSpec, signal?: AbortSignal,
    runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess): Promise<RepositoryCheck> {
    spec = structuredClone(spec);
    validate(spec);
    // Reject unsupported hosts before acquiring ownership, even for an otherwise valid check.
    if (runner === runCheckProcess && process.platform !== 'win32') throw new Error('Repository checks currently require Windows 10 or later');
    const id = randomUUID();
    const execution = this.store.transaction(() => {
      const execution = this.claim(executionId, id, 'check');
      if (execution.role !== 'implementation') throw new Error('Repository checks currently require an implementation execution');
      const check: RepositoryCheck = { id, executionId, spec: structuredClone(spec), phase: 'running', before: null, after: null,
        supervisorPid: null, toolPid: null, result: null, error: null };
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
      if (signal?.aborted) {
        check.result = { reason: 'interrupted', exitCode: null, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
      } else {
        this.store.transaction(() => {
          this.fenced(execution, id);
          this.store.saveCheck(id, executionId, check);
          this.store.appendExecution(executionId, 'check.dispatch_requested', { checkId: id, artifact: check.before!.artifact });
        });
        dispatched = true;
        check.result = await runner({ file: spec.file, args: spec.args, cwd: this.workspaces.get(execution.workspaceId).path!, timeoutMs: spec.timeoutMs,
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
      }
    } catch (error) { check.error = error instanceof Error ? error.message : String(error); }
    return this.store.transaction(() => {
      this.fenced(execution, id);
      const confirmed = check.result?.exitConfirmed ?? !dispatched;
      check.phase = !confirmed ? 'recovery_required' : signal?.aborted || check.result?.reason === 'interrupted' ? 'interrupted'
        : !check.error && check.result?.reason === 'exited' && check.result.exitCode === 0 ? 'passed' : 'failed';
      if (confirmed) this.release(execution, id);
      else {
        const task = this.store.get<Task>(execution.taskId);
        task.phase = 'recovery_required'; task.attempt!.outcome = 'uncertain';
        this.store.save(task.id, task);
      }
      this.store.saveCheck(id, executionId, check);
      const event = { checkId: id, phase: check.phase, artifact: check.before?.artifact, result: check.result, error: check.error };
      this.store.appendExecution(executionId, 'check.settled', event);
      this.store.append(execution.taskId, execution.version, 'check.settled', event);
      return check;
    });
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
