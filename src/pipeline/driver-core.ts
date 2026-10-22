// The task driver's machinery: recording events, idempotent Orca requests, the inbox pump, user
// commands, decision points and running one stage as an Orca worker. Every step looks at recorded state
// first, so a restarted driver continues where the last one stopped instead of repeating work. The
// pipeline itself (which stages run in which order) is in pipeline.ts.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { currentSettings } from '../config/settings.js';
import type { Assignment } from '../domain/recipe.js';
import type { CommandKind, Stage, StoredEvent, TaskEvent, UserCommand } from '../domain/events.js';
import { OrcaError, OrcaUncertainError, type Orca } from '../orca/client.js';
import { lifecyclePayloadSchema, type OrcaMessage, type WorkerStartReceipt } from '../orca/protocol.js';
import type { TaskStore } from '../store/task-store.js';
import {
  applyEvent,
  currentDispatch,
  foldEvents,
  type DispatchRecord,
  type StageRecord,
  type TaskState,
} from './state.js';

/** Orca's refusal to give a worker that cannot take another dispatch (a Chat UI worker) a new task. */
const reuseRefused = 'terminal_unsupported_for_agent_session';

/** The user abandoned the task. */
export class TaskAbandoned extends Error {
  constructor(readonly reason: string | null) {
    super('The task was abandoned.');
  }
}

/** The driver cannot continue safely. Running `grampus drive` again resumes from the log. */
export class DriverStop extends Error {}

/** How a stage's worker is launched. */
export type Launch = { assignment: Assignment } | { reuse: DispatchRecord; fallback: Assignment };

export interface StageRequest {
  key: string;
  stage: Stage;
  round: number;
  title: string;
  /** Builds the task spec. Called once, when the Orca task is created. */
  spec: () => string;
  launch: Launch;
}

/** A settled worker dispatch. */
export interface Settled {
  record: StageRecord;
  dispatch: DispatchRecord;
  outcome: 'succeeded' | 'failed';
  body: string;
}

export type Log = (line: string) => void;

export class DriverCore {
  readonly events: StoredEvent[];
  readonly state: TaskState;
  private pendingAck: string | null = null;
  private lastLiveness = 0;

  constructor(
    readonly store: TaskStore,
    readonly orca: Orca,
    readonly log: Log,
  ) {
    this.events = store.events();
    this.state = foldEvents(this.events);
  }

  /** Append an event and apply it to the in-memory state. */
  record(event: TaskEvent): StoredEvent {
    const stored = this.store.append(event);
    this.events.push(stored);
    applyEvent(this.state, stored);
    return stored;
  }

  /** The request id for one Orca mutation, recorded before first use so a retry reuses it. */
  requestId(key: string): string {
    const existing = this.state.requests.get(key);
    if (existing) return existing;
    const requestId = randomUUID();
    this.record({ type: 'orca.requested', key, requestId });
    return requestId;
  }

  runId(): string {
    if (!this.state.runId) throw new Error('The task has no Orca run yet.');
    return this.state.runId;
  }

  /** Process user commands and one round of Orca messages. Throws `TaskAbandoned` when the user abandons. */
  async pump(): Promise<void> {
    await this.applyCommands();
    if (!this.state.runId) {
      await sleep(currentSettings().inboxWaitMs);
      return;
    }
    const delivery = await this.orca.check(this.state.runId, {
      waitMs: currentSettings().inboxWaitMs,
      ...(this.pendingAck ? { ack: this.pendingAck } : {}),
    });
    this.pendingAck = null;
    for (const message of delivery.messages) await this.handleMessage(message);
    // Acknowledge only after every message is recorded; a crash before then replays the batch.
    this.pendingAck = delivery.deliveryId;
    await this.checkLiveness();
    await this.applyCommands();
  }

  /** Pump until the predicate holds. */
  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) await this.pump();
  }

  /**
   * Ask the user to choose and wait for the command. `key` identifies the decision point, so after a
   * restart a decision already made is returned instead of being asked again.
   */
  async decide(key: string, detail: string, options: CommandKind[]): Promise<UserCommand> {
    const made = this.decisionAfter(key, options);
    if (made) return made;
    if (this.state.attention?.reason !== key) {
      this.record({ type: 'attention.needed', reason: key, detail, options });
      this.log(`Needs you: ${detail} [${options.join(', ')}]`);
    }
    for (;;) {
      await this.pump();
      const decision = this.decisionAfter(key, options);
      if (decision) return decision;
    }
  }

  private decisionAfter(key: string, options: CommandKind[]): UserCommand | null {
    const index = this.events.findLastIndex(event => event.type === 'attention.needed' && event.reason === key);
    if (index < 0) return null;
    for (const event of this.events.slice(index + 1))
      if (event.type === 'command.applied' && options.includes(event.command.kind)) return event.command;
    return null;
  }

  private async applyCommands(): Promise<void> {
    for (const command of this.store.commands()) {
      if (this.state.applied.has(command.id)) continue;
      const refusal = this.refusal(command);
      if (refusal) {
        this.record({ type: 'command.refused', command, reason: refusal });
        this.log(`Refused ${command.kind}: ${refusal}`);
        continue;
      }
      if (command.kind === 'reply') await this.orca.reply(command.messageId, command.body, command.id);
      this.record({ type: 'command.applied', command });
      this.log(`Applied ${command.kind} from ${command.source}.`);
      if (command.kind === 'abandon') throw new TaskAbandoned(command.reason ?? null);
    }
  }

  private refusal(command: UserCommand): string | null {
    if (this.state.finished) return 'the task is finished';
    if (command.kind === 'abandon') return null;
    if (command.kind === 'reply') {
      const question = this.state.questions.get(command.messageId);
      if (!question) return `no question ${command.messageId}`;
      return question.answered ? 'that question was already answered' : null;
    }
    const attention = this.state.attention;
    if (!attention?.options.includes(command.kind)) return `nothing is waiting for ${command.kind}`;
    if (command.kind === 'approve') {
      const latest = this.state.specs.at(-1);
      if (latest?.version !== command.specVersion) return `spec version ${command.specVersion} is not the latest`;
    }
    return null;
  }

  private async handleMessage(message: OrcaMessage): Promise<void> {
    if (this.state.messages.has(message.id)) return;
    if (message.type === 'heartbeat') return;
    const payload = parsePayload(message.payload);
    const owner = payload?.dispatchId ? this.findDispatch(payload.dispatchId) : null;
    const body = message.body ?? '';
    if (message.type === 'worker_done' && owner && !owner.dispatch.settled && payload?.outcome) {
      // Decide the settled terminal's next owner before acknowledging: keep it for reuse or inspection.
      // Release happens when the task finishes.
      await this.orca.retainWorker(owner.dispatch.dispatchId).catch((error: unknown) => {
        this.log(`Could not retain ${owner.dispatch.dispatchId}: ${(error as Error).message}`);
      });
      this.record({
        type: 'stage.settled',
        key: owner.record.key,
        dispatchId: owner.dispatch.dispatchId,
        messageId: message.id,
        outcome: payload.outcome,
        subject: message.subject,
        body,
      });
      this.log(`${owner.record.key} ${payload.outcome}: ${message.subject}`);
      return;
    }
    this.record({
      type: 'worker.message',
      messageId: message.id,
      key: owner?.record.key ?? null,
      kind: message.type,
      subject: message.subject,
      body,
    });
    if (message.type === 'question')
      this.log(`Question ${message.id} from ${owner?.record.key ?? 'a worker'}: ${body || message.subject}`);
    else this.log(`${message.type} from ${owner?.record.key ?? 'a worker'}: ${message.subject}`);
  }

  private findDispatch(dispatchId: string): { record: StageRecord; dispatch: DispatchRecord } | null {
    for (const record of this.state.stages.values()) {
      const dispatch = record.dispatches.find(item => item.dispatchId === dispatchId);
      if (dispatch) return { record, dispatch };
    }
    return null;
  }

  /** Record a worker as exited only on Orca's positive `exited` verdict; anything else is still waiting. */
  private async checkLiveness(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLiveness < currentSettings().livenessIntervalMs) return;
    this.lastLiveness = now;
    for (const record of this.state.stages.values()) {
      const dispatch = currentDispatch(record);
      if (!dispatch || dispatch.settled || dispatch.exited) continue;
      const view = await this.orca.showWorker(dispatch.dispatchId).catch(() => null);
      if (view?.liveness !== 'exited') continue;
      this.record({ type: 'stage.exited', key: record.key, dispatchId: dispatch.dispatchId });
      this.log(`${record.key}: the worker exited without reporting.`);
    }
  }

  /** Run one stage as an Orca worker until it settles, handling start failures and exits with the user. */
  async runStage(request: StageRequest): Promise<Settled> {
    for (;;) {
      const record = await this.ensureStageTask(request);
      const dispatch = currentDispatch(record);
      if (dispatch?.settled)
        return { record, dispatch, outcome: dispatch.settled.outcome, body: dispatch.settled.body };
      if (!dispatch && !record.startFailure) {
        await this.start(record, request, null);
        continue;
      }
      const failed = record.startFailure;
      if (failed || dispatch?.exited) {
        const what = failed ? `could not start (${failed.state}): ${failed.error}` : 'exited without reporting';
        const choice = await this.decide(`stage-failed:${record.key}:${record.attempts}`, `${record.key} ${what}`, [
          'retry',
          'abandon',
        ]);
        if (choice.kind !== 'retry') continue;
        const previous = failed?.dispatchId ?? dispatch?.dispatchId ?? null;
        if (failed?.state === 'outcome_unknown' && previous)
          await this.orca
            .stopWorker(previous)
            .catch((error: unknown) => this.log(`Stop failed: ${(error as Error).message}`));
        await this.start(record, request, previous);
        continue;
      }
      await this.waitFor(() => {
        const current = currentDispatch(this.state.stages.get(record.key));
        return Boolean(current?.settled || current?.exited);
      });
    }
  }

  private async ensureStageTask(request: StageRequest): Promise<StageRecord> {
    const existing = this.state.stages.get(request.key);
    if (existing) return existing;
    const orcaTaskId = await this.mutate(() =>
      this.orca.createTask(
        { runId: this.runId(), title: request.title, spec: request.spec() },
        this.requestId(`${request.key}:task`),
      ),
    );
    this.record({ type: 'stage.created', key: request.key, stage: request.stage, round: request.round, orcaTaskId });
    const created = this.state.stages.get(request.key);
    if (!created) throw new Error('unreachable');
    return created;
  }

  private async start(record: StageRecord, request: StageRequest, retryOf: string | null): Promise<void> {
    const attempt = `${record.key}:start:${record.attempts + 1}`;
    const reuse = 'reuse' in request.launch ? await this.reusableHandle(request.launch.reuse) : null;
    const assignment = 'reuse' in request.launch ? request.launch.fallback : request.launch.assignment;
    let receipt: WorkerStartReceipt;
    try {
      receipt = await this.startWorker(record, reuse ? { terminal: reuse } : { assignment }, retryOf, attempt);
    } catch (error) {
      if (!(error instanceof OrcaError)) throw error;
      if (reuse && error.code === reuseRefused) {
        // Continuing a conversation is an optimisation: Orca applied nothing, so start a fresh worker.
        this.record({ type: 'stage.reuse_refused', key: record.key, handle: reuse, error: error.message });
        this.log(`${record.key}: Orca cannot continue that worker; starting a fresh one.`);
        return this.start(record, { ...request, launch: { assignment } }, retryOf);
      }
      this.record({
        type: 'stage.start_failed',
        key: record.key,
        dispatchId: dispatchIdIn(error.data),
        state: error.code,
        error: error.message,
      });
      return;
    }
    if (receipt.state !== 'ready') {
      const error =
        receipt.lastError ??
        `worker-start ended in ${receipt.state}${receipt.failedStage ? ` at ${receipt.failedStage}` : ''}`;
      this.record({
        type: 'stage.start_failed',
        key: record.key,
        dispatchId: receipt.dispatchId,
        state: receipt.state,
        error,
      });
      return;
    }
    this.record({
      type: 'stage.started',
      key: record.key,
      dispatchId: receipt.dispatchId,
      assignment: reuse ? null : assignment,
      reusedHandle: reuse,
      launch: receipt.launch
        ? { requested: receipt.launch.requested ?? null, effective: receipt.launch.effective ?? null }
        : null,
    });
    this.log(`${record.key} started (${reuse ? 'continuing a conversation' : assignment.agent}).`);
  }

  private startWorker(
    record: StageRecord,
    target: { terminal: string } | { assignment: Assignment },
    retryOf: string | null,
    attempt: string,
  ): Promise<WorkerStartReceipt> {
    // A fresh start after a refused reuse is a different request from the refused one.
    const requestId = this.requestId('terminal' in target ? attempt : `${attempt}:fresh`);
    const request = { runId: this.runId(), taskId: record.orcaTaskId, worktree: 'current', ...target };
    return this.mutate(() => this.orca.startWorker({ ...request, ...(retryOf ? { retryOf } : {}) }, requestId));
  }

  /** The handle that continues a settled worker's conversation, unless Orca has refused reuse in this task. */
  private async reusableHandle(previous: DispatchRecord): Promise<string | null> {
    if (this.state.reuseUnsupported) return null;
    const view = await this.orca.showWorker(previous.dispatchId).catch(() => null);
    return view?.handle ?? null;
  }

  /** Run an Orca mutation. An uncertain result stops the driver; rerunning it replays the same request id. */
  async mutate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof OrcaUncertainError)
        throw new DriverStop(`${error.message} Run \`grampus drive ${this.state.taskId}\` again to replay it safely.`);
      throw error;
    }
  }

  /** Release every worker the task started: stop unsettled ones, release settled ones. */
  async releaseWorkers(): Promise<void> {
    if (this.state.released) return;
    const released: string[] = [];
    const failures: string[] = [];
    for (const record of this.state.stages.values())
      for (const dispatch of record.dispatches) {
        const action =
          dispatch.settled || dispatch.exited
            ? this.orca.releaseWorker(dispatch.dispatchId)
            : this.orca.stopWorker(dispatch.dispatchId);
        await action.then(
          () => released.push(dispatch.dispatchId),
          (error: unknown) => failures.push(`${dispatch.dispatchId}: ${(error as Error).message}`),
        );
      }
    this.record({ type: 'workers.released', released, failures });
  }
}

function parsePayload(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const parsed = lifecyclePayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function dispatchIdIn(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const value = (data as Record<string, unknown>)['dispatchId'];
    if (typeof value === 'string') return value;
  }
  return null;
}
