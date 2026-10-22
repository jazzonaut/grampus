// An in-memory Orca for driver tests. Workers are test-supplied behaviours that edit the real task
// worktree and report like a real worker would: through a worker_done message in the Run's inbox.
// Mutations honour request ids the way Orca does: a repeated id replays the first result.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  OrcaBusyError,
  OrcaError,
  OrcaUncertainError,
  type Delivery,
  type Orca,
  type OrcaDesk,
  type OrcaWorkspaces,
  type WorkerStartRequest,
  type WorkerView,
} from '../../src/orca/client.js';
import type { OrcaMessage, WorkerStartReceipt } from '../../src/orca/protocol.js';
import { git } from '../../src/git/git.js';

export interface WorkerContext {
  title: string;
  spec: string;
  dispatchId: string;
  request: WorkerStartRequest;
  /** Ask the coordinator a question; resolves with the reply. */
  ask(question: string): Promise<string>;
}

export interface WorkerResult {
  outcome: 'succeeded' | 'failed';
  subject?: string;
  body?: string;
}

/** A behaviour returns a result, or `'hang'` to never report. */
export type Behaviour = (context: WorkerContext) => Promise<WorkerResult | 'hang'> | WorkerResult | 'hang';

export interface StartCall {
  request: WorkerStartRequest;
  requestId: string;
  title: string;
  /** The task spec (prompt) the worker received. */
  spec: string;
}

export class FakeOrca implements Orca, OrcaWorkspaces, OrcaDesk {
  readonly starts: StartCall[] = [];
  readonly released: string[] = [];
  readonly stopped: string[] = [];
  readonly retained: string[] = [];
  readonly replies = new Map<string, string>();
  readonly gates = new Map<string, string | null>();
  readonly runs: string[] = [];
  /** Request ids seen per operation, to assert idempotent replays. */
  readonly mutations: { name: string; requestId: string; replayed: boolean }[] = [];
  /** Throw an uncertain error for the next N worker starts (after recording them, like a lost response). */
  failNextStarts = 0;
  /** Make the next inbox check fail unexpectedly, as if the driver process died. */
  failNextCheck = false;
  /** Leave the next N inbox checks uncertain, as an unreachable Orca does. */
  uncertainChecks = 0;
  /** Turn the next N inbox checks away unapplied, as Orca does when its long-poll slots are full. */
  busyChecks = 0;
  /** Turn the next N worker starts away unapplied, likewise. */
  busyStarts = 0;
  /** Leave the next N worker releases uncertain. */
  uncertainReleases = 0;
  /** Refuse replies, as Orca does for a question whose worker has gone. */
  refuseReplies = false;
  /** Refuse `--terminal` reuse, as Orca does for workers started in Chat UI mode. */
  refuseReuse = false;
  liveness = new Map<string, string>();
  private readonly results = new Map<string, unknown>();
  private readonly tasks = new Map<string, { title: string; spec: string }>();
  private readonly inbox: OrcaMessage[] = [];
  private delivery: { id: string; messages: OrcaMessage[] } | null = null;

  constructor(private readonly behaviour: Behaviour) {}

  async version() {
    return 'fake-1.0';
  }

  async createRun(objective: string, requestId: string) {
    return this.once('run-create', requestId, () => {
      const runId = `run_${this.runs.length + 1}`;
      this.runs.push(objective);
      return { runId, coordinatorHandle: 'term_driver' };
    });
  }

  async useRun() {}

  async createTask(input: { runId: string; title: string; spec: string }, requestId: string) {
    return this.once('task-create', requestId, () => {
      const id = `task_${this.tasks.size + 1}`;
      this.tasks.set(id, { title: input.title, spec: input.spec });
      return id;
    });
  }

  async createGate(_input: { taskId: string }, requestId: string) {
    return this.once('gate-create', requestId, () => {
      const id = `gate_${this.gates.size + 1}`;
      this.gates.set(id, null);
      return id;
    });
  }

  async resolveGate(gateId: string, resolution: string, requestId: string) {
    this.once('gate-resolve', requestId, () => this.gates.set(gateId, resolution));
  }

  async startWorker(request: WorkerStartRequest, requestId: string): Promise<WorkerStartReceipt> {
    if (this.busyStarts > 0) {
      this.busyStarts--;
      throw new OrcaBusyError('orca orchestration worker-start: Orca is busy (long-poll capacity reached)');
    }
    if (this.refuseReuse && request.terminal)
      throw new OrcaError(
        'terminal_unsupported_for_agent_session',
        `${request.terminal} is an agent session, not a terminal`,
      );
    const receipt = this.once('worker-start', requestId, () => {
      const task = this.tasks.get(request.taskId);
      if (!task) throw new OrcaError('task_not_found', `No task ${request.taskId}`);
      const dispatchId = `dispatch_${this.starts.length + 1}`;
      this.starts.push({ request, requestId, title: task.title, spec: task.spec });
      void this.runWorker(dispatchId, request, task);
      return {
        taskId: request.taskId,
        dispatchId,
        state: 'ready',
        launch: { requested: request.assignment ?? null, effective: request.assignment ?? null },
      } satisfies WorkerStartReceipt;
    });
    if (this.failNextStarts > 0) {
      this.failNextStarts--;
      throw new OrcaUncertainError('worker-start response lost');
    }
    return receipt;
  }

  async check(_runId: string, options: { waitMs: number; ack?: string }): Promise<Delivery> {
    if (this.failNextCheck) {
      this.failNextCheck = false;
      throw new Error('connection lost');
    }
    if (this.busyChecks > 0) {
      this.busyChecks--;
      throw new OrcaBusyError(
        'orca orchestration check: Orca is busy (long-poll capacity reached; retry with backoff)',
      );
    }
    if (this.uncertainChecks > 0) {
      this.uncertainChecks--;
      throw new OrcaUncertainError('orca orchestration check: Orca is not running.');
    }
    if (options.ack && this.delivery?.id === options.ack) this.delivery = null;
    if (!this.delivery && this.inbox.length)
      this.delivery = { id: `delivery_${randomUUID()}`, messages: this.inbox.splice(0) };
    if (this.delivery) return { deliveryId: this.delivery.id, messages: this.delivery.messages };
    await sleep(Math.min(options.waitMs, 20));
    return { deliveryId: null, messages: [] };
  }

  async reply(messageId: string, body: string, requestId: string) {
    if (this.refuseReplies) throw new OrcaError('message_not_found', `No open question ${messageId}`);
    this.once('reply', requestId, () => this.replies.set(messageId, body));
  }

  async showWorker(dispatchId: string): Promise<WorkerView> {
    return { handle: `term_${dispatchId}`, liveness: this.liveness.get(dispatchId) ?? 'live' };
  }

  async retainWorker(dispatchId: string) {
    this.retained.push(dispatchId);
  }

  async releaseWorker(dispatchId: string) {
    if (this.uncertainReleases > 0) {
      this.uncertainReleases--;
      throw new OrcaUncertainError('orca orchestration worker-release did not finish.');
    }
    this.released.push(dispatchId);
  }

  async stopWorker(dispatchId: string) {
    this.stopped.push(dispatchId);
  }

  /** Provider sessions per dispatch, for measurement tests. */
  sessions = new Map<string, { provider: string; sessionIds: string[] }>();

  async transcriptSessions(dispatchId: string) {
    return this.sessions.get(dispatchId) ?? { provider: null, sessionIds: [] };
  }

  async createWorktree(input: { repoPath: string; name: string; baseRef?: string }) {
    const path = `${input.repoPath}-${input.name}`;
    await git(input.repoPath, ['worktree', 'add', '-b', input.name, path, ...(input.baseRef ? [input.baseRef] : [])]);
    return { id: `wt:${path}`, path };
  }

  /** Commands of the terminals Grampus created. */
  readonly terminals: string[] = [];
  /** Where each terminal was created: `id:<worktree>` or `path:<checkout>`. */
  readonly terminalPlaces: string[] = [];
  /** Terminals Grampus closed, by handle. */
  readonly closed: string[] = [];
  /** The first terminal Orca opens in every new worktree. */
  readonly firstTerminal = 'term_first';

  async listTerminals() {
    return [this.firstTerminal];
  }

  async closeTerminal(handle: string) {
    this.closed.push(handle);
  }

  /** Handles for the next terminals created, in order; `term_driver` once these run out. */
  nextTerminals: string[] = [];
  /** Titles of live terminals by handle, for the ones a test or Grampus opened. */
  readonly titles = new Map<string, string>();

  async createTerminal(input: { worktree: { id: string } | { path: string }; title: string; command: string }) {
    this.terminals.push(input.command);
    this.terminalPlaces.push('id' in input.worktree ? `id:${input.worktree.id}` : `path:${input.worktree.path}`);
    const handle = this.nextTerminals.shift() ?? 'term_driver';
    this.titles.set(handle, input.title);
    return handle;
  }

  async terminalTitle(handle: string) {
    return this.closed.includes(handle) ? null : (this.titles.get(handle) ?? null);
  }

  /** Repositories Orca knows, for the dashboard's new-task form. */
  repos: { id: string; path: string; name: string }[] = [];
  /** Tabs the dashboard brought forward: `terminal:<handle>` or `changes:<path>`. */
  readonly opened: string[] = [];

  async listRepos() {
    return this.repos;
  }

  async switchTerminal(handle: string) {
    this.opened.push(`terminal:${handle}`);
  }

  async openChangedFiles(worktreePath: string) {
    this.opened.push(`changes:${worktreePath}`);
  }

  /** Messages delivered so far that the driver has not acknowledged. */
  pending(): number {
    return this.inbox.length + (this.delivery?.messages.length ?? 0);
  }

  private once<T>(name: string, requestId: string, run: () => T): T {
    if (this.results.has(requestId)) {
      this.mutations.push({ name, requestId, replayed: true });
      return this.results.get(requestId) as T;
    }
    const result = run();
    this.results.set(requestId, result);
    this.mutations.push({ name, requestId, replayed: false });
    return result;
  }

  private async runWorker(dispatchId: string, request: WorkerStartRequest, task: { title: string; spec: string }) {
    await sleep(1);
    const context: WorkerContext = {
      title: task.title,
      spec: task.spec,
      dispatchId,
      request,
      ask: async question => {
        const id = `msg_${randomUUID()}`;
        // Like Orca's `ask`, the question names the asking dispatch.
        const payload = JSON.stringify({ taskId: request.taskId, dispatchId });
        this.inbox.push(message(id, 'question', 'Question', question, payload));
        while (!this.replies.has(id)) await sleep(5);
        return this.replies.get(id) ?? '';
      },
    };
    // A behaviour that throws is a worker that gave up: it reports failure, as a real worker should.
    const result = await Promise.resolve()
      .then(() => this.behaviour(context))
      .catch((error: unknown): WorkerResult => ({ outcome: 'failed', body: String(error) }));
    if (result === 'hang') return;
    const payload = JSON.stringify({ taskId: request.taskId, dispatchId, outcome: result.outcome });
    this.inbox.push(
      message(`msg_${randomUUID()}`, 'worker_done', result.subject ?? 'done', result.body ?? 'Did the work.', payload),
    );
  }
}

function message(id: string, type: string, subject: string, body: string, payload: string | null): OrcaMessage {
  return { id, type, subject, body, payload, from_handle: 'term_worker', created_at: new Date().toISOString() };
}
