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
import { retainedTaskSpec } from './task-spec.js';
import {
  accountListSchema,
  checkSchema,
  errorEnvelopeSchema,
  gateCreateSchema,
  okEnvelopeSchema,
  providerLimits,
  repoListSchema,
  runCreateSchema,
  statusSchema,
  taskCreateSchema,
  terminalCreateSchema,
  terminalListSchema,
  terminalShowSchema,
  workerReadSchema,
  workerShowSchema,
  workerStartSchema,
  worktreeSchema,
  type OrcaMessage,
  type ProviderLimits,
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

/**
 * Orca turned the call away before running it (`runtime_busy`): all its long-poll slots were taken, by
 * `check --wait`, `worker-start` and workers' `ask` among others. Nothing was applied, so it is replayed
 * until Orca has room, without counting towards the uncertain-call budget.
 */
export class OrcaBusyError extends OrcaUncertainError {
  constructor(message: string) {
    super(message);
    this.name = 'OrcaBusyError';
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
  /** Close an Orca terminal, such as the driver's own tab once its task has finished. */
  closeTerminal(handle: string): Promise<void>;
  /** The provider and provider session ids behind a dispatch, from Orca's transcript view. */
  transcriptSessions(dispatchId: string): Promise<{ provider: string | null; sessionIds: string[] }>;
}

/** Workspace calls made when a task is created, before its driver exists. */
export interface OrcaWorkspaces {
  /** A new worktree, from the repository's default base or from `baseRef` (a branch or commit). */
  createWorktree(input: { repoPath: string; name: string; baseRef?: string }): Promise<{ id: string; path: string }>;
  /** A terminal in a worktree, named by Orca id or by path (a repository's main checkout has a path, not an id). */
  createTerminal(input: {
    worktree: { id: string } | { path: string };
    title: string;
    command: string;
  }): Promise<string>;
  /** Handles of the live terminals in a worktree. */
  listTerminals(worktreeId: string): Promise<string[]>;
  /** The title a live terminal was created with, or null when the terminal is gone. */
  terminalTitle(handle: string): Promise<string | null>;
  closeTerminal(handle: string): Promise<void>;
  /**
   * Remove a worktree from Orca and Git; `force` discards uncommitted changes. Orca also deletes the
   * worktree's branch when it can tell the branch is merged. False when Orca no longer knows the worktree.
   */
  removeWorktree(worktreeId: string, options: { force: boolean }): Promise<boolean>;
}

/** Calls the dashboard makes for the user: listing repositories and bringing Orca tabs forward. */
export interface OrcaDesk {
  listRepos(): Promise<{ id: string; path: string; name: string }[]>;
  /** Bring a terminal tab to the front in the Orca window. */
  switchTerminal(handle: string): Promise<void>;
  /** Open a worktree's changed files as diff tabs in Orca and show them. */
  openChangedFiles(worktreePath: string): Promise<void>;
}

/** Orca's own view of whether it is up, as `orca status` reports it. Unknown fields stay null. */
export interface OrcaStatus {
  appRunning: boolean | null;
  reachable: boolean | null;
  /** The runtime's state, such as `ready`. */
  state: string | null;
  version: string | null;
}

/** What the dashboard asks Orca to judge system health. Both calls use the given deadline. */
export interface OrcaHealth {
  status(timeoutMs: number): Promise<OrcaStatus>;
  /** Sign-in state and usage limits of each agent provider Orca knows. */
  providerLimits(timeoutMs: number): Promise<ProviderLimits[]>;
}

/** The real Orca CLI. */
export class OrcaCli implements Orca, OrcaWorkspaces, OrcaDesk, OrcaHealth {
  constructor(private readonly command: readonly string[] = currentSettings().orcaCommand) {}

  async status(timeoutMs: number): Promise<OrcaStatus> {
    const { app, runtime } = await this.parse(statusSchema, ['status'], undefined, timeoutMs);
    return {
      appRunning: app?.running ?? null,
      reachable: runtime?.reachable ?? null,
      state: runtime?.state ?? null,
      version: runtime?.appVersion ?? null,
    };
  }

  async providerLimits(timeoutMs: number): Promise<ProviderLimits[]> {
    const { rateLimits } = await this.parse(accountListSchema, ['account', 'list'], undefined, timeoutMs);
    return providerLimits(rateLimits ?? {});
  }

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
    try {
      return (await this.parse(taskCreateSchema, args, requestId)).task.id;
    } catch (error) {
      // spawn rejected the command before Orca could receive it. Only this known non-delivery permits
      // changing transport; uncertain responses must still replay the original request unchanged.
      if ((error as NodeJS.ErrnoException).code !== 'ENAMETOOLONG') throw error;
      args[args.indexOf('--spec') + 1] = retainedTaskSpec(input.runId, requestId, input.spec);
      return (await this.parse(taskCreateSchema, args, requestId)).task.id;
    }
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
      handle: shown.dispatch?.assigneeHandle ?? shown.worker?.agentTerminalHandle ?? null,
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

  async createWorktree(input: { repoPath: string; name: string; baseRef?: string }) {
    const args = ['worktree', 'create', '--repo', `path:${input.repoPath}`, '--name', input.name];
    args.push('--no-parent', '--setup', 'run');
    if (input.baseRef) args.push('--base-branch', input.baseRef);
    const { worktree } = await this.parse(worktreeSchema, args);
    return { id: worktree.id, path: worktree.path };
  }

  async createTerminal(input: { worktree: { id: string } | { path: string }; title: string; command: string }) {
    const selector = 'id' in input.worktree ? `id:${input.worktree.id}` : `path:${input.worktree.path}`;
    const args = ['terminal', 'create', '--worktree', selector, '--title', input.title];
    args.push('--command', input.command);
    return (await this.parse(terminalCreateSchema, args)).terminal.handle;
  }

  async listTerminals(worktreeId: string) {
    const listed = await this.parse(terminalListSchema, ['terminal', 'list', '--worktree', `id:${worktreeId}`]);
    return listed.terminals.map(terminal => terminal.handle);
  }

  async terminalTitle(handle: string) {
    try {
      const { terminal } = await this.parse(terminalShowSchema, ['terminal', 'show', '--terminal', handle]);
      // A shell overwrites the tab title with its own; the pane keeps the title the terminal was created with.
      return terminal.paneTitle ?? terminal.title ?? null;
    } catch (error) {
      if (error instanceof OrcaError && error.code === 'terminal_handle_stale') return null;
      throw error;
    }
  }

  async closeTerminal(handle: string) {
    await this.call(['terminal', 'close', '--terminal', handle]);
  }

  async removeWorktree(worktreeId: string, options: { force: boolean }) {
    const args = ['worktree', 'rm', '--worktree', `id:${worktreeId}`];
    if (options.force) args.push('--force');
    try {
      await this.call(args);
      return true;
    } catch (error) {
      if (error instanceof OrcaError && error.code === 'selector_not_found') return false;
      throw error;
    }
  }

  async listRepos() {
    const { repos } = await this.parse(repoListSchema, ['repo', 'list']);
    return repos.map(repo => ({ id: repo.id, path: repo.path, name: repo.displayName ?? repo.path }));
  }

  async switchTerminal(handle: string) {
    await this.call(['terminal', 'switch', '--terminal', handle]);
  }

  async openChangedFiles(worktreePath: string) {
    await this.call(['file', 'open-changed', '--worktree', `path:${worktreePath}`, '--mode', 'diff', '--focus']);
  }

  private async parse<T>(schema: z.ZodType<T>, args: string[], requestId?: string, timeoutMs?: number): Promise<T> {
    const result = schema.safeParse(await this.call(args, requestId, timeoutMs));
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
    if (failed.success) {
      const { code, message, data } = failed.data.error;
      if (code === busyCode) throw new OrcaBusyError(`${name}: Orca is busy (${message})`);
      if (unknownOutcomeCodes.has(code))
        throw new OrcaUncertainError(`${name} could not reach Orca (${code}): ${message}`);
      throw new OrcaError(code, message, data);
    }
    throw new OrcaUncertainError(`${name} printed an unrecognised envelope.`);
  }
}

/**
 * Error codes Orca's own CLI treats as an unknown mutation outcome: the runtime was unreachable or did
 * not answer, so the call may or may not have been applied. They are not refusals.
 */
const unknownOutcomeCodes = new Set([
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'invalid_runtime_response',
]);

/** Orca's admission refusal: it applied nothing and asks the caller to retry with backoff. */
const busyCode = 'runtime_busy';

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
