// The task driver's machinery: recording events, idempotent Orca requests, the inbox pump, user
// commands, decision points and running one stage as an Orca worker. Every step looks at recorded state
// first, so a restarted driver continues where the last one stopped instead of repeating work. The
// pipeline itself (which stages run in which order) is in pipeline.ts.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { currentSettings } from '../config/settings.js';
import type { Assignment } from '../domain/recipe.js';
import type { CommandKind, Stage, StoredEvent, TaskEvent, UserCommand } from '../domain/events.js';
import { OrcaBusyError, OrcaError, OrcaUncertainError, type Delivery, type Orca } from '../orca/client.js';
import { lifecyclePayloadSchema, type OrcaMessage, type WorkerStartReceipt } from '../orca/protocol.js';
import type { TaskStore } from '../store/task-store.js';
import {
  applyEvent,
  currentDispatch,
  foldEvents,
  isOpen,
  type DispatchRecord,
  type StageRecord,
  type TaskState,
} from './state.js';

/** Orca's refusal to give a worker that cannot take another dispatch (a Chat UI worker) a new task. */
const reuseRefused = 'terminal_unsupported_for_agent_session';

const minuteMs = 60_000;

/** The user ended the task early: abandoned it, or picked another entry of its comparison. */
export class TaskAbandoned extends Error {
  constructor(
    readonly reason: string | null,
    readonly outcome: 'abandoned' | 'not-selected' = 'abandoned',
  ) {
    super(outcome === 'abandoned' ? 'The task was abandoned.' : 'Another comparison entry was picked.');
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

/** When a dispatch last showed signs of life: its start, a message from its stage, or an answer to it. */
export function lastActivity(
  state: TaskState,
  events: readonly StoredEvent[],
  record: StageRecord,
  dispatch: DispatchRecord,
): number {
  let last = Date.parse(dispatch.startedAt);
  for (const event of events) {
    const active =
      (event.type === 'worker.message' && event.key === record.key) ||
      (event.type === 'command.applied' &&
        event.command.kind === 'reply' &&
        state.questions.get(event.command.messageId)?.key === record.key);
    if (active) last = Math.max(last, Date.parse(event.at));
  }
  return last;
}

export class DriverCore {
  readonly events: StoredEvent[];
  readonly state: TaskState;
  private pendingAck: string | null = null;
  private lastLiveness = 0;
  /** When Orca began turning inbox checks away as busy, or null; each spell is logged and recorded once. */
  private busySince: number | null = null;

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
    const runId = this.state.runId;
    if (!runId) {
      await sleep(currentSettings().inboxWaitMs);
      return;
    }
    const delivery = await this.checkInbox(runId);
    // Orca was busy: nothing was delivered or acknowledged, so the acknowledgement waits for the next check.
    if (!delivery) return;
    this.pendingAck = null;
    for (const message of delivery.messages) await this.handleMessage(message);
    // Acknowledge only after every message is recorded; a crash before then replays the batch.
    this.pendingAck = delivery.deliveryId;
    await this.checkLiveness();
    await this.applyCommands();
  }

  /**
   * One inbox check, or null when Orca turned it away as busy. A busy check applied nothing, so the
   * driver backs off and tries again on the next pump, for as long as it takes, applying user commands
   * in between; only an uncertain check counts towards stopping. A repeated check leaves the
   * acknowledgement out, as a restarted driver does: Orca delivers anything unacknowledged again, and
   * messages already recorded are skipped by id.
   */
  private async checkInbox(runId: string): Promise<Delivery | null> {
    const ack = this.pendingAck;
    const delivery = await this.mutate(async repeat => {
      try {
        return await this.orca.check(runId, {
          waitMs: currentSettings().inboxWaitMs,
          ...(ack && repeat === 0 ? { ack } : {}),
        });
      } catch (error) {
        if (!(error instanceof OrcaBusyError)) throw error;
        return null;
      }
    });
    if (delivery) {
      if (this.busySince !== null) this.roomAgain(this.busySince);
      this.busySince = null;
      return delivery;
    }
    if (this.busySince === null) {
      this.log('Orca is busy (all its long-poll slots are taken); waiting for room.');
      this.record({ type: 'orca.busy', detail: 'inbox check: all long-poll slots are taken' });
      this.busySince = Date.now();
    }
    await sleep(currentSettings().orcaRetryDelayMs);
    return null;
  }

  private roomAgain(busySince: number): void {
    this.log('Orca has room again.');
    this.record({ type: 'orca.room', waitedMs: Date.now() - busySince });
  }

  /** Pump until the predicate holds. */
  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) await this.pump();
  }

  /**
   * Ask the user to choose and wait for the command. `key` identifies the decision point, so after a
   * restart a decision already made is returned instead of being asked again.
   */
  async decide(
    key: string,
    detail: string,
    options: CommandKind[],
    /** Runs after every pump while waiting, for work that continues alongside the decision. */
    watch?: () => Promise<void> | void,
  ): Promise<UserCommand> {
    const made = this.decisionAfter(key, options);
    if (made) return made;
    if (this.state.attention?.reason !== key) this.requestDecision(key, detail, options);
    for (;;) {
      await this.pump();
      const decision = this.decisionAfter(key, options);
      if (decision) return decision;
      await watch?.();
    }
  }

  /**
   * Like `decide`, for a request that can lapse: once `lapsed` holds before the user answers, the request
   * is withdrawn (`why` says why) and null is returned.
   */
  async decideUnless(
    key: string,
    detail: string,
    options: CommandKind[],
    lapsed: () => boolean,
    why: string,
  ): Promise<UserCommand | null> {
    for (;;) {
      const decision = this.decisionAfter(key, options);
      if (decision) return decision;
      if (lapsed()) {
        if (this.state.attention?.reason === key) {
          this.record({ type: 'attention.withdrawn', reason: key, why });
          this.log(`No longer needs you: ${why}`);
        }
        return null;
      }
      if (this.state.attention?.reason !== key) this.requestDecision(key, detail, options);
      await this.pump();
    }
  }

  /** Raise (or raise again, with new detail) a decision request, which wakes `grampus wait`. */
  requestDecision(key: string, detail: string, options: CommandKind[]): void {
    this.record({ type: 'attention.needed', reason: key, detail, options });
    this.log(`Needs you: ${detail} [${options.join(', ')}]`);
  }

  private decisionAfter(key: string, options: CommandKind[]): UserCommand | null {
    const index = this.events.findLastIndex(event => event.type === 'attention.needed' && event.reason === key);
    if (index < 0) return null;
    for (const event of this.events.slice(index + 1)) {
      if (event.type === 'attention.withdrawn' && event.reason === key) return null;
      if (event.type === 'command.applied' && options.includes(event.command.kind)) return event.command;
    }
    return null;
  }

  private async applyCommands(): Promise<void> {
    for (const command of this.store.commands()) {
      if (this.state.applied.has(command.id)) continue;
      const refusal = this.refusal(command) ?? (command.kind === 'reply' ? await this.relay(command) : null);
      if (refusal) {
        this.record({ type: 'command.refused', command, reason: refusal });
        this.log(`Refused ${command.kind}: ${refusal}`);
        continue;
      }
      this.record({ type: 'command.applied', command });
      this.log(`Applied ${command.kind} from ${command.source}.`);
      if (command.kind === 'abandon') throw new TaskAbandoned(command.reason ?? null);
      if (command.kind === 'decline') throw new TaskAbandoned('another comparison entry was picked', 'not-selected');
    }
  }

  private refusal(command: UserCommand): string | null {
    if (this.state.finished) return 'the task is finished';
    if (command.kind === 'abandon') return null;
    if (command.kind === 'decline') return this.state.comparisonId ? null : 'only a comparison entry can be declined';
    if (command.kind === 'reply') {
      const question = this.state.questions.get(command.messageId);
      if (!question) return `no question ${command.messageId}`;
      if (question.answered) return 'that question was already answered';
      return question.closed ? 'the worker that asked it has finished' : null;
    }
    const attention = this.state.attention;
    if (!attention?.options.includes(command.kind)) return `nothing is waiting for ${command.kind}`;
    if (command.kind === 'approve') {
      const latest = this.state.specs.at(-1);
      if (latest?.version !== command.specVersion) return `spec version ${command.specVersion} is not the latest`;
    }
    return null;
  }

  /**
   * Relay an answer to the worker that asked. Returns why Orca refused it, such as a worker that has
   * gone, so the refusal is recorded instead of stopping the driver on every restart.
   */
  private async relay(command: Extract<UserCommand, { kind: 'reply' }>): Promise<string | null> {
    try {
      await this.mutate(() => this.orca.reply(command.messageId, command.body, command.id));
      return null;
    } catch (error) {
      if (error instanceof OrcaError) return `Orca refused the reply: ${error.message}`;
      throw error;
    }
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
          await this.repeatUncertain(() => this.orca.stopWorker(previous)).catch((error: unknown) =>
            this.log(`Stop failed: ${(error as Error).message}`),
          );
        await this.start(record, request, previous);
        continue;
      }
      if (dispatch && this.quiet(record, dispatch)) {
        await this.askAboutQuietWorker(record, request, dispatch);
        continue;
      }
      await this.waitFor(() => {
        const current = currentDispatch(record);
        return Boolean(current?.settled || current?.exited || (current && this.quiet(record, current)));
      });
    }
  }

  /**
   * A worker that has not reported, asked or been answered for `stalledWorkerMs` may be stuck, for
   * example on a prompt in its terminal; Orca still calls it alive. Ask the user while it keeps running:
   * `retry` replaces it, and the request is withdrawn if the worker shows signs of life first.
   */
  private async askAboutQuietWorker(record: StageRecord, request: StageRequest, dispatch: DispatchRecord) {
    const minutes = Math.round((Date.now() - lastActivity(this.state, this.events, record, dispatch)) / minuteMs);
    const choice = await this.decideUnless(
      `stage-quiet:${record.key}:${record.attempts}`,
      `${record.key} has not reported, asked or been answered for ${minutes} minutes; it may be stuck, for example on a prompt in its Orca terminal. It keeps running while you decide: retry replaces it with a fresh worker.`,
      ['retry', 'abandon'],
      () => !this.quiet(record, dispatch),
      `${record.key} is no longer quiet`,
    );
    // A retry that crossed with the worker's report is moot: the report stands.
    if (choice?.kind !== 'retry' || dispatch.settled) return;
    await this.stopStage(record.key, 'the user retried a worker that had gone quiet');
    await this.start(record, request, dispatch.dispatchId);
  }

  /** Whether a running dispatch has been silent too long while not waiting for the user. */
  private quiet(record: StageRecord, dispatch: DispatchRecord): boolean {
    if (dispatch.settled || dispatch.exited) return false;
    for (const question of this.state.questions.values())
      if (question.key === record.key && isOpen(question)) return false;
    return Date.now() - lastActivity(this.state, this.events, record, dispatch) >= currentSettings().stalledWorkerMs;
  }

  /**
   * Start a stage's worker without waiting for it, for work that runs alongside a decision. Start
   * failures are recorded, not escalated: the caller treats them as a missing result.
   */
  async launchStage(request: StageRequest): Promise<StageRecord> {
    const record = await this.ensureStageTask(request);
    if (!currentDispatch(record) && !record.startFailure) await this.start(record, request, null);
    return record;
  }

  /**
   * Run a stage the task can do without until its worker ends. A start failure or an exit is returned
   * as an error instead of asking the user to retry.
   */
  async runOptionalStage(request: StageRequest): Promise<Settled | { error: string }> {
    const record = await this.launchStage(request);
    const ended = () => {
      const current = this.state.stages.get(record.key);
      const dispatch = currentDispatch(current);
      return Boolean(current?.startFailure || dispatch?.settled || dispatch?.exited);
    };
    await this.waitFor(ended);
    const current = this.state.stages.get(record.key) ?? record;
    const dispatch = currentDispatch(current);
    if (dispatch?.settled)
      return { record: current, dispatch, outcome: dispatch.settled.outcome, body: dispatch.settled.body };
    if (current.startFailure)
      return { error: `could not start (${current.startFailure.state}): ${current.startFailure.error}` };
    return { error: 'exited without reporting' };
  }

  /** Stop a stage's worker if it is still running, because its result is no longer needed. */
  async stopStage(key: string, reason: string): Promise<void> {
    const dispatch = currentDispatch(this.state.stages.get(key));
    if (!dispatch || dispatch.settled || dispatch.exited) return;
    await this.repeatUncertain(() => this.orca.stopWorker(dispatch.dispatchId)).catch((error: unknown) => {
      this.log(`Could not stop ${key}: ${(error as Error).message}`);
    });
    this.record({ type: 'stage.stopped', key, dispatchId: dispatch.dispatchId, reason });
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

  /**
   * Run an Orca mutation (or a read). An uncertain result is repeated, as a restarted driver would repeat
   * it, so the call must carry its recorded request id. One that stays uncertain stops the driver;
   * rerunning it replays the same request id. `repeat` counts the repeats so far.
   */
  async mutate<T>(call: (repeat: number) => Promise<T>): Promise<T> {
    try {
      return await this.repeatUncertain(call);
    } catch (error) {
      if (error instanceof OrcaUncertainError)
        throw new DriverStop(`${error.message} Run \`grampus drive ${this.state.taskId}\` again to replay it safely.`);
      throw error;
    }
  }

  /**
   * Run an Orca call, repeating it while its outcome is uncertain, such as while Orca restarts. Only for
   * calls that are safe to repeat: mutations with their recorded request id, reads, and stop or release.
   * A busy refusal applied nothing, so it is repeated for as long as Orca stays busy and does not count
   * towards `orcaRetries`; a run of parallel drivers can hold every long-poll slot for many minutes.
   */
  async repeatUncertain<T>(call: (repeat: number) => Promise<T>): Promise<T> {
    const { orcaRetries, orcaRetryDelayMs } = currentSettings();
    let uncertain = 0;
    let busySince: number | null = null;
    for (let repeat = 0; ; repeat++) {
      try {
        const result = await call(repeat);
        if (busySince !== null) this.roomAgain(busySince);
        return result;
      } catch (error) {
        if (error instanceof OrcaBusyError) {
          if (busySince === null) {
            this.log(`${error.message} Waiting for room.`);
            this.record({ type: 'orca.busy', detail: error.message });
            busySince = Date.now();
          }
          await sleep(orcaRetryDelayMs);
          continue;
        }
        if (!(error instanceof OrcaUncertainError) || uncertain >= orcaRetries) throw error;
        uncertain++;
        this.log(`${error.message} Repeating it (${uncertain} of ${orcaRetries}).`);
        this.record({ type: 'orca.uncertain', detail: error.message, repeat: uncertain });
        await sleep(orcaRetryDelayMs * uncertain);
      }
    }
  }

  /** Release every worker the task started: stop unsettled ones, release settled ones. */
  async releaseWorkers(): Promise<void> {
    if (this.state.released) return;
    const released: string[] = [];
    const failures: string[] = [];
    for (const record of this.state.stages.values())
      for (const dispatch of record.dispatches) {
        const action = this.repeatUncertain(() =>
          dispatch.settled || dispatch.exited
            ? this.orca.releaseWorker(dispatch.dispatchId)
            : this.orca.stopWorker(dispatch.dispatchId),
        );
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
