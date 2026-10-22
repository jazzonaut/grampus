// The Orca CLI client. Every call goes through `orca ... --json` and is parsed at the boundary.
//
// Identity: the driver runs inside its own Orca terminal, so Orca resolves the caller from that
// terminal's environment and Grampus never passes `--from` or `--terminal`. Idempotence: each
// mutation carries a caller-generated UUID (`--retry-request`). Orca executes the first call and
// replays the recorded receipt for a repeat, so re-issuing a mutation after a crash or an uncertain
// result is safe as long as the same id is used.
import type { z } from 'zod';
import { currentSettings } from '../config/settings.js';
import type { Assignment } from '../domain/recipe.js';
import { runProcess } from '../process/run.js';
import {
  checkSchema,
  errorEnvelopeSchema,
  gateCreateSchema,
  okEnvelopeSchema,
  runCreateSchema,
  statusSchema,
  taskCreateSchema,
  terminalCreateSchema,
  workerReadSchema,
  workerShowSchema,
  workerStartSchema,
  worktreeSchema,
  type OrcaMessage,
  type WorkerStartReceipt,
} from './protocol.js';

/** Orca answered and refused the call. The error code is Orca's stable `error.code`. */
export class OrcaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'OrcaError';
  }
}

/** The call's outcome is unknown: it timed out, crashed or printed no envelope. Replay it with the same request id. */
export class OrcaUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrcaUncertainError';
  }
}

export interface WorkerStartRequest {
  runId: string;
  taskId: string;
  /** `current` (the driver's worktree) or an exact Orca worktree selector. */
  worktree: string;
  /** A fresh agent launch. Exactly one of `assignment` and `terminal` is set. */
  assignment?: Assignment;
  /** Reuse a settled worker's terminal or chat, continuing its conversation. */
  terminal?: string;
  /** The failed dispatch this start replaces. */
  retryOf?: string;
}

export interface Delivery {
  deliveryId: string | null;
  messages: OrcaMessage[];
}

/** A worker as Orca sees it: its reusable handle and the fleet liveness verdict (`live`, `unverifiable`, `exited`). */
export interface WorkerView {
  handle: string | null;
  liveness: string | null;
}

/** Orchestration calls made by a task driver for its own Run. */
export interface Orca {
  version(): Promise<string | null>;
  createRun(objective: string, requestId: string): Promise<{ runId: string; coordinatorHandle: string | null }>;
  /** Bind the calling terminal as the Run's coordinator, e.g. after the driver moved to a new terminal. */
  useRun(runId: string): Promise<void>;
  createTask(
    input: { runId: string; title: string; spec: string; deps?: string[] },
    requestId: string,
  ): Promise<string>;
  createGate(input: { taskId: string; question: string; options: string[] }, requestId: string): Promise<string>;
  resolveGate(gateId: string, resolution: string, requestId: string): Promise<void>;
  startWorker(request: WorkerStartRequest, requestId: string): Promise<WorkerStartReceipt>;
  check(runId: string, options: { waitMs: number; ack?: string }): Promise<Delivery>;
  reply(messageId: string, body: string, requestId: string): Promise<void>;
  showWorker(dispatchId: string): Promise<WorkerView>;
  retainWorker(dispatchId: string): Promise<void>;
  releaseWorker(dispatchId: string): Promise<void>;
  stopWorker(dispatchId: string): Promise<void>;
  /** The provider and provider session ids behind a dispatch, from Orca's transcript view. */
  transcriptSessions(dispatchId: string): Promise<{ provider: string | null; sessionIds: string[] }>;
}

/** Workspace calls made when a task is created, before its driver exists. */
export interface OrcaWorkspaces {
  createWorktree(input: { repoPath: string; name: string }): Promise<{ id: string; path: string }>;
  createTerminal(input: { worktreeId: string; title: string; command: string }): Promise<string>;
}

/** The real Orca CLI. */
export class OrcaCli implements Orca, OrcaWorkspaces {
  constructor(private readonly command: readonly string[] = currentSettings().orcaCommand) {}

  async version(): Promise<string | null> {
    const result = statusSchema.safeParse(await this.call(['status']));
    return result.success ? (result.data.runtime?.appVersion ?? null) : null;
  }

  async createRun(objective: string, requestId: string) {
    const { run } = await this.parse(
      runCreateSchema,
      ['orchestration', 'run-create', '--objective', objective],
      requestId,
    );
    return { runId: run.id, coordinatorHandle: run.coordinator_handle };
  }

  async useRun(runId: string) {
    await this.call(['orchestration', 'run-use', '--id', runId]);
  }

  async createTask(input: { runId: string; title: string; spec: string; deps?: string[] }, requestId: string) {
    const args = [
      'orchestration',
      'task-create',
      '--run',
      input.runId,
      '--task-title',
      input.title,
      '--spec',
      input.spec,
    ];
    if (input.deps?.length) args.push('--deps', JSON.stringify(input.deps));
    return (await this.parse(taskCreateSchema, args, requestId)).task.id;
  }

  async createGate(input: { taskId: string; question: string; options: string[] }, requestId: string) {
    const args = ['orchestration', 'gate-create', '--task', input.taskId, '--question', input.question];
    args.push('--options', JSON.stringify(input.options));
    return (await this.parse(gateCreateSchema, args, requestId)).gate.id;
  }

  async resolveGate(gateId: string, resolution: string, requestId: string) {
    await this.call(['orchestration', 'gate-resolve', '--id', gateId, '--resolution', resolution], requestId);
  }

  async startWorker(request: WorkerStartRequest, requestId: string) {
    const args = ['orchestration', 'worker-start', '--run', request.runId, '--task', request.taskId];
    args.push('--worktree', request.worktree);
    if (request.terminal) args.push('--terminal', request.terminal);
    if (request.assignment) {
      args.push('--agent', request.assignment.agent);
      if (request.assignment.model) args.push('--model', request.assignment.model);
      if (request.assignment.effort) args.push('--effort', request.assignment.effort);
    }
    if (request.retryOf) args.push('--retry-of', request.retryOf);
    return this.parse(workerStartSchema, args, requestId);
  }

  async check(runId: string, options: { waitMs: number; ack?: string }) {
    const args = ['orchestration', 'check', '--run', runId, '--wait', '--timeout-ms', String(options.waitMs)];
    if (options.ack) args.push('--ack', options.ack);
    const timeoutMs = options.waitMs + currentSettings().orcaCallTimeoutMs;
    const result = checkSchema.parse(await this.call(args, undefined, timeoutMs));
    return { deliveryId: result.deliveryId ?? null, messages: result.messages };
  }

  async reply(messageId: string, body: string, requestId: string) {
    await this.call(['orchestration', 'reply', '--id', messageId, '--body', body], requestId);
  }

  async showWorker(dispatchId: string) {
    const shown = workerShowSchema.parse(await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId]));
    return {
      handle: shown.dispatch?.assignee_handle ?? shown.worker?.agent_terminal_handle ?? null,
      liveness: livenessVerdict(shown.projection?.liveness),
    };
  }

  async retainWorker(dispatchId: string) {
    await this.call(['orchestration', 'worker-retain', '--dispatch', dispatchId]);
  }

  async releaseWorker(dispatchId: string) {
    await this.call(['orchestration', 'worker-release', '--dispatch', dispatchId]);
  }

  async stopWorker(dispatchId: string) {
    await this.call(['orchestration', 'worker-stop', '--dispatch', dispatchId]);
  }

  async transcriptSessions(dispatchId: string) {
    const args = ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript'];
    const read = workerReadSchema.parse(await this.call([...args, '--limit', String(transcriptPageMessages)]));
    return { provider: read.provider ?? null, sessionIds: providerSessions(read.transcript?.messages ?? []) };
  }

  async createWorktree(input: { repoPath: string; name: string }) {
    const args = ['worktree', 'create', '--repo', `path:${input.repoPath}`, '--name', input.name];
    args.push('--no-parent', '--setup', 'run');
    const { worktree } = await this.parse(worktreeSchema, args);
    return { id: worktree.id, path: worktree.path };
  }

  async createTerminal(input: { worktreeId: string; title: string; command: string }) {
    const args = ['terminal', 'create', '--worktree', `id:${input.worktreeId}`, '--title', input.title];
    args.push('--command', input.command);
    return (await this.parse(terminalCreateSchema, args)).terminal.handle;
  }

  private async parse<T>(schema: z.ZodType<T>, args: string[], requestId?: string): Promise<T> {
    const result = schema.safeParse(await this.call(args, requestId));
    if (!result.success)
      throw new OrcaUncertainError(
        `orca ${args.slice(0, 2).join(' ')} returned an unexpected result: ${result.error.message}`,
      );
    return result.data;
  }

  private async call(args: string[], requestId?: string, timeoutMs = currentSettings().orcaCallTimeoutMs) {
    const [file, ...prefix] = this.command;
    if (!file) throw new Error('No Orca command is configured.');
    const full = [...prefix, ...args, ...(requestId ? ['--retry-request', requestId] : []), '--json'];
    const name = `orca ${args.slice(0, 2).join(' ')}`;
    const result = await runProcess(file, full, { timeoutMs });
    if (result.timedOut) throw new OrcaUncertainError(`${name} did not finish within ${timeoutMs} ms.`);
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      const detail = (result.stderr || result.stdout).trim().slice(-500);
      throw new OrcaUncertainError(`${name} printed no JSON (exit ${result.exitCode}): ${detail}`);
    }
    const ok = okEnvelopeSchema.safeParse(json);
    if (ok.success) return ok.data.result;
    const failed = errorEnvelopeSchema.safeParse(json);
    if (failed.success) throw new OrcaError(failed.data.error.code, failed.data.error.message, failed.data.error.data);
    throw new OrcaUncertainError(`${name} printed an unrecognised envelope.`);
  }
}

/** Messages read to find a dispatch's provider sessions; the first page always contains provider messages. */
const transcriptPageMessages = 50;

/** Provider session ids named by Orca transcript message ids such as `claude:<session>:<message>`. */
export function providerSessions(messages: readonly { id: string }[]): string[] {
  const sessions = new Set<string>();
  for (const { id } of messages) {
    const [provider, session] = id.split(':');
    if ((provider === 'claude' || provider === 'codex') && session) sessions.add(session);
  }
  return [...sessions];
}

/** Reads Orca's fleet liveness verdict, which is either a word or an object carrying one. */
function livenessVerdict(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const verdict = record['status'] ?? record['verdict'];
    if (typeof verdict === 'string') return verdict;
  }
  return null;
}
