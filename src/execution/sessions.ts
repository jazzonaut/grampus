// Owns Grampus sessions and their provider turns: claiming a turn under a run id, journaling provider
// events fenced on that run, confirming the provider's exit and settling once, and recovery of
// conversation turns. A turn is never replayed; an unconfirmed exit leaves the session for explicit recovery.
import type { RepositoryAccess } from '../repository/repository-tools.js';
import { modelAssignmentSchema, type ModelAssignment, type ReasoningEffort } from '../domain/model-profiles.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { Execution, Session, TurnStage } from '../persistence/records.js';
import { processLimits } from '../config/limits.js';
import { agentTimeout } from './agent-timeout.js';
import { connectAgent } from '../providers/index.js';
import { performance } from 'node:perf_hooks';
import type { ExecutionPhase } from './phase-timing.js';
import { providerRuntime, type ProviderRuntime } from '../providers/executables.js';
import { Workspaces } from '../repository/workspaces.js';
import { claimExecution, requireExecutionLease, settleExecution, stopExecution } from './execution-state.js';
import { Workflow, activeSlice, activeCriteria } from '../domain/workflow.js';
import { currentProcessStartedAt, inspectProcess } from '../process/process-identity.js';
import { processAlive as ownedProcessAlive } from '../verification/check-recovery.js';
import { captureRepository, reviewContext } from '../repository/repository-evidence.js';
import { PromptBudget, PromptBudgetError, promptBytes, requirePromptBudget } from '../providers/prompt-budget.js';
import {
  agentToolsetVersion,
  parseReply,
  type AgentEvent,
  type AgentSession,
  type Connector,
  type Provider,
  type TurnResult,
} from '../providers/types.js';
import { taskCheckEvidence, checkEvidenceSummary } from '../verification/check-evidence.js';
import { OutputBuffer, deltaText } from './output-buffer.js';
import { parseBoundary } from '../process/boundary.js';

export type { Session } from '../persistence/records.js';

// Adapter events whose data changes session state. Adapters are in-process, but their data repeats
// what the provider reported, so it is validated before it becomes session identity.
const connectedEventSchema = z.object({ providerSessionId: z.string().min(1), model: z.string().nullish() });
const processStartedEventSchema = z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** The part of a `turn.requested` session event that identifies the turn. */
const turnRequestedSchema = z.object({ runId: z.string() });

/**
 * The run ids of every turn requested in a session, in order. Settlement adopts a turn by these ids,
 * so a malformed event is a journal error rather than a turn that silently disappears.
 */
export function requestedTurnIds(store: Store, sessionId: string): string[] {
  return store
    .sessionEvents(sessionId, ['turn.requested'])
    .map(
      event =>
        parseBoundary(turnRequestedSchema, event.data, { kind: 'journal-record', source: 'session_events' }).runId,
    );
}

const turnRefusalSchema = z.object({
  runId: z.string(),
  result: z.object({ refused: z.literal('prompt_budget').exactOptional() }),
});

/**
 * Whether the settled turn `runId` was refused before dispatch because its prompt could not fit the
 * budget. Callers name that stop distinctly instead of reporting a failed provider turn.
 */
export function turnRefusedForBudget(store: Store, sessionId: string, runId: string): boolean {
  return store.sessionEvents(sessionId, ['turn.result']).some(event => {
    const settled = parseBoundary(turnRefusalSchema, event.data, { kind: 'journal-record', source: 'session_events' });
    return settled.runId === runId && settled.result.refused === 'prompt_budget';
  });
}

/**
 * Session records and the turn protocol on them. A session's `run` is the single active turn; every write
 * for a turn checks the run id (and, for an execution, its workspace lease), so a late event from a
 * stopped or superseded turn is ignored or refused rather than applied.
 */
export class Sessions {
  constructor(private readonly store: Store) {}
  get(id: string): Session {
    return this.store.session(id);
  }

  /**
   * Create an idle session. `runtime` records the provider program a turn would start now; callers
   * inside a transaction resolve it first, because resolving may run the executable's `--version`.
   */
  create(
    provider: Provider,
    cwd: string,
    model: string | null = null,
    runtime: ProviderRuntime = providerRuntime(provider),
    effort?: ReasoningEffort,
  ): Session {
    if (!['codex', 'claude'].includes(provider)) throw new Error('Provider must be codex or claude');
    const directory = resolve(cwd);
    if (!statSync(directory).isDirectory()) throw new Error('Session directory must exist');
    const session: Session = {
      id: randomUUID(),
      provider,
      runtime,
      providerSessionId: null,
      model,
      requestedModel: model,
      ...(effort ? { effort } : {}),
      cwd: directory,
      phase: 'idle',
      lastReply: null,
      run: null,
    };
    this.store.transaction(() => {
      this.store.saveSession(session.id, session);
      this.store.appendSession(session.id, 'session.created', session);
    });
    return session;
  }

  /** Changes a settled editing role's assignment, starting fresh when model or effort differs. */
  assign(id: string, input: ModelAssignment): void {
    const assignment = modelAssignmentSchema.parse(input);
    this.change(id, session => {
      if (session.run || ['running', 'stop_requested', 'recovery_required'].includes(session.phase))
        throw new Error('Model assignment requires a settled session');
      if (session.provider !== assignment.provider)
        throw new Error('Editing provider cannot change within an execution');
      if (session.requestedModel === assignment.model && session.effort === assignment.effort) return;
      if (session.phase === 'awaiting_answer') throw new Error('Answer the pending questions before changing models');
      const previous = { model: session.model, effort: session.effort, providerSessionId: session.providerSessionId };
      session.providerSessionId = null;
      session.model = assignment.model;
      session.requestedModel = assignment.model;
      if (assignment.effort) session.effort = assignment.effort;
      else delete session.effort;
      this.store.appendSession(id, 'session.assignment_changed', { previous, assignment, freshConversation: true });
    });
  }

  private change<T>(id: string, action: (session: Session) => T): T {
    return this.store.transaction(() => {
      const session = this.get(id);
      const result = action(session);
      this.store.saveSession(id, session);
      return result;
    });
  }

  /**
   * Claims the session for one turn and journals `turn.requested` with the turn's usage stage: the
   * linked execution's stage, `planning` without one, or `stage` when the caller names a turn kind the
   * execution does not imply (an edit quality pass in the implementation conversation).
   * `editing` claims an `implementation` lease instead of a `conversation` one; `trackDispatch` records a
   * provider dispatch boundary on the run (native editing tracks dispatch on its implementation run).
   *
   * @throws Error when the session is deleted, in the wrong mode, already owned or needing recovery, the
   *   answers do not match the pending questions, or the execution's workspace cannot be claimed.
   */
  claim(
    id: string,
    prompt: string,
    answers?: Record<string, string>,
    editing = false,
    trackDispatch = false,
    stage?: Extract<TurnStage, 'quality_pass'>,
  ): { session: Session; prompt: string; runId: string } {
    if (answers !== undefined && (!answers || typeof answers !== 'object' || Array.isArray(answers)))
      throw new Error('Answers must be a JSON object');
    // The first identity query of a process starts PowerShell: make it before taking the write lock.
    const controllerStartedAt = currentProcessStartedAt();
    return this.change(id, session => {
      if (session.deletedAt) throw new Error('This planning conversation was deleted');
      this.requireMode(session, editing);
      if (['running', 'stop_requested', 'recovery_required'].includes(session.phase))
        throw new Error('Session already owned or needs recovery; no automatic replay');
      prompt = this.answeredPrompt(session, prompt, answers);
      if (!prompt.trim()) throw new Error('Prompt must not be empty');
      session.run = {
        id: randomUUID(),
        controllerPid: process.pid,
        controllerStartedAt,
        host: hostname(),
        providerPid: null,
        providerStartedAt: null,
        ...(trackDispatch ? { providerDispatch: 'not_requested' as const } : {}),
      };
      claimExecution(this.store, session, session.run.id, editing ? 'implementation' : 'conversation');
      const execution = this.store.executionForSession(id);
      if (execution) prompt = this.taskPrompt(session, execution, editing, prompt);
      session.phase = 'running';
      this.store.appendSession(id, 'turn.requested', {
        runId: session.run.id,
        stage: stage ?? execution?.stage ?? 'planning',
        prompt,
        autoRetries: 0,
        configuration: {
          providerSessionId: session.providerSessionId,
          requestedModel: session.requestedModel ?? null,
          model: session.model,
          effort: session.effort ?? null,
        },
      });
      return { session: structuredClone(session), prompt, runId: session.run.id };
    });
  }

  /**
   * Native editing needs an implementation execution and a fresh or editing-mode conversation; once a
   * session edits, only editing turns may continue it, because its tools differ.
   */
  private requireMode(session: Session, editing: boolean): void {
    if (editing) {
      if (session.providerSessionId && session.mode !== 'editing')
        throw new Error('Native editing requires a fresh session or an existing editing session');
      const execution = this.store.executionForSession(session.id);
      if (execution?.role !== 'implementation') throw new Error('Native editing requires an implementation execution');
      session.mode = 'editing';
    } else if (session.mode === 'editing') throw new Error('Use execution-implement to continue an editing session');
  }

  /**
   * The prompt with the answers to the pending questions appended, journaling them. Answers are
   * required exactly when questions are pending: one nonempty answer per question id.
   */
  private answeredPrompt(session: Session, prompt: string, answers: Record<string, string> | undefined): string {
    if (session.phase !== 'awaiting_answer') {
      if (answers) throw new Error('Session has no pending questions');
      return prompt;
    }
    const questions = session.lastReply?.questions;
    if (!questions) throw new Error('The pending questions are missing; recover the session');
    if (
      !answers ||
      Object.keys(answers).length !== questions.length ||
      questions.some(q => {
        const answer = answers[q.id];
        return typeof answer !== 'string' || !answer.trim();
      })
    ) {
      throw new Error('Answer every pending question by its id');
    }
    this.store.appendSession(session.id, 'questions.answered', { answers });
    return `${prompt.trim() ? `${prompt}\n\n` : ''}User answers to the pending questions:\n${JSON.stringify(answers)}`;
  }

  /**
   * Prefixes an execution's turn with the approved task context, so the agent works from the
   * controller's record rather than its own memory. A continued conversation gets the short form.
   */
  private taskPrompt(session: Session, execution: Execution, editing: boolean, prompt: string): string {
    const task = this.store.get(execution.taskId);
    return `Approved task context (${editing ? 'native implementation; report your checks as observations and submit a candidate, not controller completion' : 'conversation only; do not claim repository execution or completion'}):\n${JSON.stringify(
      {
        ...(session.providerSessionId
          ? { title: task.brief.title, criteria: activeCriteria(task), continuedConversation: true }
          : { brief: task.brief }),
        version: execution.version,
        attemptId: execution.attemptId,
        role: execution.role,
        artifact: execution.artifact,
        ...(task.slice
          ? {
              currentSlice: activeSlice(task),
              completedSlices: task.slice.completed,
              scope:
                'Work on the current slice only. The final slice requires integration review and verification of every task criterion.',
            }
          : {}),
      },
    )}\n\nUser turn:\n${prompt}`;
  }

  /**
   * Journals one provider event for the active run and applies the ones that change session identity:
   * the provider conversation id and model, and the provider process identity that recovery later needs
   * to prove its exit. Returns false (journaled as ignored) when the run no longer owns the session.
   *
   * @throws Error when the run lost its execution lease, or the provider conversation id is missing or changed.
   */
  event(id: string, runId: string, event: AgentEvent): boolean {
    // Observed before the write lock: the query starts PowerShell, which would hold up every other
    // task's journal writes. The provider's identity does not depend on what the transaction reads.
    const startedPid =
      event.type === 'process.started' ? processStartedEventSchema.safeParse(event.data).data?.pid : undefined;
    const observed = startedPid === undefined ? null : inspectProcess(startedPid);
    return this.change(id, session => {
      if (session.run?.id !== runId || !['running', 'stop_requested'].includes(session.phase)) {
        this.store.appendSession(id, 'event.ignored', { runId, eventType: event.type });
        return false;
      }
      const execution = requireExecutionLease(this.store, session, runId);
      if (event.type === 'session.connected') {
        const connected = connectedEventSchema.safeParse(event.data);
        if (!connected.success) throw new Error('Missing provider session identity');
        const data = connected.data;
        if (session.providerSessionId && session.providerSessionId !== data.providerSessionId)
          throw new Error('Provider session identity changed');
        session.providerSessionId = data.providerSessionId;
        session.toolsetVersion = agentToolsetVersion;
        if (data.model) session.model = data.model;
        if (execution?.role === 'implementation' && data.model) {
          const task = this.store.get(execution.taskId);
          if (task.attempt?.id === execution.attemptId && task.version === execution.version) {
            task.attempt.agent.model = data.model;
            this.store.save(task.id, task);
            this.store.append(task.id, task.version, 'execution.model_observed', {
              executionId: execution.id,
              model: data.model,
            });
          }
        }
      }
      // A null start time (the process was not observed) means recovery must see the PID absent.
      if (startedPid !== undefined && observed) {
        session.run.providerPid = startedPid;
        session.run.providerStartedAt = observed.state === 'present' ? observed.startedAt : null;
        session.run.providerDispatch = 'requested';
      }
      this.store.appendSession(id, event.type, { runId, data: event.data });
      return true;
    });
  }

  /**
   * Journals coalesced streamed text for the active run. Unlike {@link Sessions.event} it never
   * rewrites the session record: output changes no session state, so a flush is one small insert.
   */
  delta(id: string, runId: string, text: string): boolean {
    return this.store.transaction(() => {
      const session = this.get(id);
      if (session.run?.id !== runId || !['running', 'stop_requested'].includes(session.phase)) {
        this.store.appendSession(id, 'event.ignored', { runId, eventType: 'output.delta' });
        return false;
      }
      requireExecutionLease(this.store, session, runId);
      this.store.appendSession(id, 'output.delta', { runId, data: { text } });
      return true;
    });
  }

  /**
   * The provider dispatch boundary: journaled before the provider process is started, so recovery can
   * prove a turn whose boundary is still `not_requested` never launched anything.
   *
   * @throws Error when the run no longer owns a running session or already crossed the boundary.
   */
  requestConnection(id: string, runId: string): void {
    this.change(id, session => {
      if (session.run?.id !== runId || session.phase !== 'running' || session.run.providerDispatch !== 'not_requested')
        throw new Error('Provider connection ownership changed');
      session.run.providerDispatch = 'requested';
      this.store.appendSession(id, 'connection.requested', { runId });
    });
  }

  /**
   * Journals a stop request for the running turn (and its implementation attempt). It only records intent;
   * the caller interrupts the provider. A no-op when the run is not the session's running turn.
   */
  stop(id: string, runId: string, reason: string): void {
    this.change(id, session => {
      if (session.run?.id !== runId || session.phase !== 'running') return;
      stopExecution(this.store, session, runId, reason);
      session.phase = 'stop_requested';
      this.store.appendSession(id, 'stop.requested', { runId, reason });
    });
  }

  /**
   * Settles the run's turn with its result. With a confirmed exit the session becomes idle, awaiting an
   * answer, failed or interrupted and any execution lease is released; without one it becomes
   * `recovery_required` and keeps the run and lease. A result for a run that no longer owns the session is journaled as
   * ignored. A stop request makes the turn interrupted whatever the provider returned.
   */
  settle(id: string, runId: string, result: TurnResult, exitConfirmed: boolean): void {
    this.change(id, session => {
      if (session.run?.id !== runId || !['running', 'stop_requested'].includes(session.phase)) {
        this.store.appendSession(id, 'result.ignored', { runId });
        return;
      }
      this.store.appendSession(id, 'turn.result', { runId, result, exitConfirmed });
      if (!exitConfirmed) {
        settleExecution(this.store, session, runId, result.status, false);
        session.phase = 'recovery_required';
        return;
      }
      this.store.appendSession(id, 'process.exit_confirmed', { runId });
      if (session.phase === 'stop_requested' || result.status === 'interrupted') session.phase = 'interrupted';
      else if (result.status === 'failed') session.phase = 'failed';
      else {
        session.lastReply = parseReply(result.reply);
        session.phase = session.lastReply.kind === 'question' ? 'awaiting_answer' : 'idle';
      }
      settleExecution(
        this.store,
        session,
        runId,
        session.phase === 'interrupted' ? 'interrupted' : result.status,
        true,
      );
      session.run = null;
    });
  }

  /**
   * Explicit recovery of a conversation turn whose controller died, without replaying it. The original
   * controller must be provably gone on this host, and either the dispatch boundary proves no provider was
   * requested or the recorded provider process is provably gone. The turn settles interrupted. Native
   * editing sessions are refused because only a supervisor receipt can prove their settlement.
   *
   * @throws Error when any of those proofs is missing.
   */
  recover(id: string, alive = ownedProcessAlive): void {
    this.change(id, session => {
      if (session.mode === 'editing')
        throw new Error('Native editing requires implementation-recover with supervisor settlement proof');
      if (!session.run || !['running', 'stop_requested', 'recovery_required'].includes(session.phase))
        throw new Error('Session does not need recovery');
      if (session.run.host !== hostname()) throw new Error('Reconcile this session on its execution host');
      if (alive(session.run.controllerPid, session.run.controllerStartedAt))
        throw new Error('Previous controller is still alive or unverifiable');
      const undispatched = session.run.providerDispatch === 'not_requested' && session.run.providerPid === null;
      if (
        !undispatched &&
        (session.run.providerPid === null || alive(session.run.providerPid, session.run.providerStartedAt))
      )
        throw new Error('Provider exit is unconfirmed; do not start a duplicate session');
      this.store.appendSession(id, 'session.recovered', {
        runId: session.run.id,
        evidence: undispatched
          ? 'Controller absent and durable boundary proves provider connection was never requested'
          : 'Original controller and recorded provider process identities are absent',
        replayed: false,
      });
      settleExecution(this.store, session, session.run.id, 'interrupted', true);
      session.phase = 'interrupted';
      session.run = null;
    });
  }
}

/** How one turn is run. Every field is optional; `timeoutMs` defaults to the agent timeout. */
export interface RunOptions {
  repository?: RepositoryAccess;
  timeoutMs?: number;
  /** Probe-only fault injection: request a stop this long after the provider turn starts. */
  interruptAfterMs?: number;
  signal?: AbortSignal;
  answers?: Record<string, string>;
  onEvent?: (event: AgentEvent) => void;
  /** Review the execution's bound artifact read-only and record the verdict as review evidence. */
  artifactReview?: boolean;
}

/** A claimed turn: the session as claimed, the prompt to send and the run id every effect is fenced on. */
type TurnClaim = ReturnType<Sessions['claim']>;

const interruptedBeforeResult = (): TurnResult => ({
  status: 'interrupted',
  reply: null,
  usage: null,
  error: 'Interrupted before a final provider result',
});

/**
 * The live state of one provider turn: stop requests, timers, coalesced output and what is known
 * about the provider process. Its flags decide whether the process exit can be confirmed, which is
 * what allows the session to settle rather than require recovery.
 */
class TurnRun {
  private stopped = false;
  private connectionFinished = false;
  private connectionPending = false;
  private connectorClosed = false;
  private processStarted = false;
  private agent: AgentSession | null = null;
  private readonly connectionAbort = new AbortController();
  private interruptTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private stopNow: () => void = () => {};
  /** Resolves once a stop has waited its grace period; racing it ends the turn without a result. */
  private readonly stopSignal = new Promise<void>(resolve => {
    this.stopNow = resolve;
  });
  private readonly output: OutputBuffer;

  private async measure<T>(phase: ExecutionPhase, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome = 'failed';
    try {
      const value = await operation();
      outcome = 'completed';
      return value;
    } finally {
      this.sessions.event(this.id, this.claim.runId, {
        type: 'execution.phase_measured',
        data: { phase, elapsedMs: performance.now() - started, outcome },
      });
    }
  }

  constructor(
    private readonly sessions: Sessions,
    private readonly id: string,
    readonly claim: TurnClaim,
    private readonly options: RunOptions,
  ) {
    this.output = new OutputBuffer(text => {
      if (sessions.delta(id, claim.runId, text)) options.onEvent?.({ type: 'output.delta', data: { text } });
    });
  }

  /** Whether a stop was requested (by the caller, the timeout or the probe). */
  get interrupted(): boolean {
    return this.stopped;
  }

  /**
   * Journals the stop, then interrupts the provider (or aborts the connection) and gives it the
   * grace period to settle. Pending output is flushed first so the journal keeps its order.
   */
  readonly requestStop = (reason: string): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.flushOutput();
    this.sessions.stop(this.id, this.claim.runId, reason);
    if (this.agent) void this.agent.interrupt().catch(() => {});
    else this.connectionAbort.abort();
    this.graceTimer = setTimeout(this.stopNow, processLimits.stopGraceMs);
  };

  private readonly aborted = () => this.requestStop('user interrupt');

  /** Streams text into the output buffer; every other event flushes it first and is journaled in order. */
  readonly emit = (event: AgentEvent): void => {
    const text = deltaText(event);
    if (text !== null) {
      this.output.add(text);
      return;
    }
    if (event.type === 'process.started') this.processStarted = true;
    if (event.type === 'process.exit_confirmed') this.connectorClosed = true;
    this.output.flush();
    if (!this.sessions.event(this.id, this.claim.runId, event)) return;
    this.options.onEvent?.(event);
    if (event.type === 'turn.started' && this.options.interruptAfterMs && !this.interruptTimer) {
      this.interruptTimer = setTimeout(
        () => this.requestStop('scheduled probe interrupt'),
        this.options.interruptAfterMs,
      );
    }
  };

  /** Starts listening for the caller's abort signal and the turn deadline (0 means none). */
  arm(timeout: number): void {
    this.options.signal?.addEventListener('abort', this.aborted, { once: true });
    if (this.options.signal?.aborted) this.aborted();
    if (timeout > 0) this.timeoutTimer = setTimeout(() => this.requestStop('turn timeout'), timeout);
  }

  /** Refuses to connect once a stop arrived while the context was being prepared. */
  requireRunning(): void {
    if (this.stopped) throw new Error('Interrupted before provider connection');
  }

  /**
   * Connects the provider and runs the turn. The connection request is journaled before the provider
   * starts, so recovery can tell an undispatched turn apart. A connection that outlives a stop is
   * closed when it eventually returns; a prompt is never sent after a stop.
   */
  async dispatch(
    connect: Connector,
    repository: RepositoryAccess | undefined,
    configurationCwd: string,
  ): Promise<TurnResult> {
    const { sessions, id, claim } = this;
    this.connectionPending = true;
    const connection = Promise.resolve()
      .then(() => {
        sessions.requestConnection(id, claim.runId);
        return this.measure('provider_startup', () =>
          connect(claim.session.provider, {
            cwd: claim.session.cwd,
            providerSessionId: claim.session.providerSessionId,
            model: claim.session.model,
            ...(claim.session.effort ? { effort: claim.session.effort } : {}),
            configurationCwd,
            signal: this.connectionAbort.signal,
            emit: this.emit,
            ...(repository ? { repository } : {}),
          }),
        );
      })
      .then(
        value => {
          this.connectionPending = false;
          this.agent = value;
          this.connectionFinished = true;
          return value;
        },
        (error: unknown) => {
          this.connectionPending = false;
          throw error;
        },
      );
    // A connection that completes after a stop still owns a provider process; close it when it arrives.
    void connection
      .then(async value => {
        if (this.stopped) await value.close();
      })
      .catch(() => {});
    const connected = await Promise.race([connection, this.stopSignal.then(() => null)]);
    if (!connected || this.stopped) {
      const interrupted: TurnResult = {
        status: 'interrupted',
        reply: null,
        usage: null,
        error: 'Interrupted during connection',
      };
      return interrupted;
    }
    const result = await this.measure('provider_turn', () =>
      Promise.race([connected.turn(claim.prompt), this.stopSignal.then(interruptedBeforeResult)]),
    );
    if (result.status === 'completed') result.reply = parseReply(result.reply);
    return result;
  }

  /**
   * Stops the timers and closes the provider process. The exit is confirmed only when `close` returned,
   * the connector reported it, or no process ever started and no connection is still pending.
   */
  async shutDown(result: TurnResult): Promise<{ result: TurnResult; exitConfirmed: boolean }> {
    clearTimeout(this.interruptTimer);
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.graceTimer);
    this.options.signal?.removeEventListener('abort', this.aborted);
    try {
      if (this.agent) {
        const agent = this.agent;
        await this.measure('provider_shutdown', () => agent.close());
        return { result, exitConfirmed: true };
      }
      return { result, exitConfirmed: this.connectorClosed || (!this.processStarted && !this.connectionPending) };
    } catch (error) {
      return {
        result: {
          ...result,
          status: 'failed',
          error: `Process shutdown unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
        },
        exitConfirmed: false,
      };
    }
  }

  /**
   * The final word before settlement: a stopped turn is interrupted whatever it returned, and a
   * connection still pending (or a stopped one whose process started but never connected) cannot have
   * a confirmed exit, because its process may yet appear.
   */
  conclude(result: TurnResult, exitConfirmed: boolean): boolean {
    if (this.stopped || this.options.signal?.aborted) {
      result.status = 'interrupted';
      result.reply = null;
    }
    const unconfirmed =
      !this.connectorClosed &&
      (this.connectionPending || (!this.connectionFinished && this.stopped && this.processStarted));
    this.flushOutput();
    return exitConfirmed && !unconfirmed;
  }

  private flushOutput(): void {
    try {
      this.output.flush();
    } catch {
      /* Display-only text; the stop or settlement that follows is what must be journaled. */
    }
  }
}

/** The agent identity review evidence names: the reviewer's own session. */
function reviewerAgent(session: Session): { provider: string; sessionId: string; model: string } {
  return { provider: session.provider, sessionId: session.id, model: session.model ?? 'provider-default' };
}

/**
 * Records skipped review evidence for the review about to run, so an earlier verdict on the same
 * artifact can no longer pass the review gate while this one is pending.
 */
function recordReviewRequested(store: Store, review: Execution, session: Session): void {
  new Workflow(store).record(review.taskId, {
    id: randomUUID(),
    attemptId: review.attemptId,
    version: review.version,
    artifact: review.artifact ?? '',
    kind: 'review',
    outcome: 'skipped',
    source: 'agent',
    summary: 'Artifact review requested; a new verified verdict is pending',
    agent: reviewerAgent(session),
    ...(review.fallbackReason ? { fallbackReason: review.fallbackReason } : {}),
  });
}

/**
 * The repository access and configuration directory of the turn. An execution's turn is refused if
 * its task version changed; a review also gets the review context, the retained check evidence and,
 * with exploration, read access bound to the reviewed snapshot.
 */
async function turnAccess(
  store: Store,
  workspaces: Workspaces,
  run: TurnRun,
  review: Execution | null,
  repository: RepositoryAccess | undefined,
): Promise<{ repository: RepositoryAccess | undefined; configurationCwd: string }> {
  const { claim } = run;
  const execution = store.executionForSession(claim.session.id);
  if (!execution) return { repository, configurationCwd: repository?.repo ?? claim.session.cwd };
  const configurationCwd = workspaces.get(execution.workspaceId).repository;
  const inspected = await workspaces.inspect(execution.workspaceId, !review);
  if (!inspected.taskCurrent) throw new Error('Execution task version changed before dispatch');
  let access = repository;
  if (review) {
    const snapshot = await captureRepository(workspaces, review);
    const plan = new Workflow(store).get(execution.taskId).guided?.plan;
    const checks = taskCheckEvidence(store, execution);
    const evidence = `\nRetained check evidence (use grampus_read_check for complete output):\n${checkEvidenceSummary(checks)}`;
    // The request (task context, verdict history, lenses) and the evidence come first; the repository
    // context fills what remains of the turn's budget.
    const budget = new PromptBudget();
    budget.require(
      promptBytes(`${claim.prompt}\n\n${evidence}`),
      'The review request and check evidence',
      'prepare an approved revision with a smaller slice or a shorter review history',
    );
    const context = await reviewContext(store, workspaces, review, snapshot, !!claim.session.providerSessionId, budget);
    claim.prompt += `\n\n${context}${evidence}`;
    if (plan?.context.exploration)
      access = { repo: claim.session.cwd, snapshot, references: plan.references ?? [], checks };
    run.emit({ type: 'review.context', data: { artifact: review.artifact, prompt: claim.prompt } });
  }
  run.requireRunning();
  return { repository: access, configurationCwd };
}

/**
 * A completed review only counts if the repository is still exactly the reviewed artifact and the
 * verdict says something; otherwise the turn fails with the reason.
 */
async function verifiedReview(workspaces: Workspaces, review: Execution, result: TurnResult): Promise<TurnResult> {
  try {
    if ((await captureRepository(workspaces, review)).artifact !== review.artifact)
      return { ...result, status: 'failed', error: 'Repository changed during review' };
    if (result.reply?.kind === 'review' && !result.reply.text.trim())
      return { ...result, status: 'failed', error: 'Review requires an explicit summary' };
    return result;
  } catch (error) {
    return { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Settles the session and, for a review this run still owned with a confirmed exit, records the
 * verdict as review evidence: failed on any blocking finding or failure, passed for a review reply,
 * skipped otherwise. One transaction, so the verdict and the session settle together.
 */
function settleTurn(
  store: Store,
  sessions: Sessions,
  run: { id: string; runId: string; review: Execution | null },
  result: TurnResult,
  exitConfirmed: boolean,
): void {
  const { id, runId, review } = run;
  store.transaction(() => {
    const owned = sessions.get(id).run?.id === runId;
    sessions.settle(id, runId, result, exitConfirmed);
    if (!review || !exitConfirmed || !owned) return;
    const session = sessions.get(id);
    const verdict = result.status === 'completed' && result.reply?.kind === 'review' ? result.reply : null;
    const outcome =
      result.status === 'failed' || verdict?.findings.some(finding => finding.severity === 'blocking')
        ? 'failed'
        : verdict !== null
          ? 'passed'
          : 'skipped';
    new Workflow(store).record(review.taskId, {
      id: runId,
      attemptId: review.attemptId,
      version: review.version,
      artifact: review.artifact ?? '',
      kind: 'review',
      outcome,
      source: 'agent',
      summary: result.error ?? (result.reply?.text.trim() || 'Artifact review did not produce a review verdict'),
      agent: reviewerAgent(session),
      ...(review.fallbackReason ? { fallbackReason: review.fallbackReason } : {}),
    });
    store.appendExecution(review.id, 'review.settled', {
      runId,
      artifact: review.artifact,
      outcome,
      findings: result.reply?.findings ?? [],
    });
  });
}

/**
 * Runs one provider turn in a session. Each CLI invocation owns one provider process, closes it and
 * keeps a resumable provider id. The turn is never retried: whatever happens, the session settles
 * once, and an unconfirmed process exit leaves it `recovery_required` rather than settled.
 */
export async function runSession(
  store: Store,
  id: string,
  prompt: string,
  options: RunOptions = {},
  connect: Connector = connectAgent,
  workspaces = new Workspaces(store),
): Promise<TurnResult> {
  const timeout = agentTimeout(options.timeoutMs);
  if (
    options.interruptAfterMs !== undefined &&
    (!Number.isSafeInteger(options.interruptAfterMs) || options.interruptAfterMs < 1)
  )
    throw new Error('Interrupt delay must be a positive integer');
  const sessions = new Sessions(store);
  const review = options.artifactReview ? store.executionForSession(id) : null;
  if (options.artifactReview && (review?.role !== 'review' || !review.artifact?.startsWith('sha256:')))
    throw new Error('Artifact review requires a review execution bound to a verified content digest');
  // The pending review marker is recorded before the claim, since `Workflow.record` refuses while the task
  // holds a lease; one transaction keeps marker and claim together.
  const claim = store.transaction(() => {
    if (review) recordReviewRequested(store, review, sessions.get(id));
    return sessions.claim(id, prompt, options.answers, false, true);
  });
  const run = new TurnRun(sessions, id, claim, options);
  run.arm(timeout);
  let result: TurnResult = { status: 'failed', reply: null, usage: null, error: 'Turn did not complete' };
  try {
    const access = await turnAccess(store, workspaces, run, review, options.repository);
    requirePromptBudget(claim.prompt);
    sessions.event(id, claim.runId, { type: 'prompt.prepared', data: { prompt: claim.prompt } });
    result = await run.dispatch(connect, access.repository, access.configurationCwd);
  } catch (error) {
    result = {
      status: run.interrupted ? 'interrupted' : 'failed',
      reply: null,
      usage: null,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PromptBudgetError ? { refused: 'prompt_budget' as const } : {}),
    };
  } finally {
    const closed = await run.shutDown(result);
    result = closed.result;
    if (review && closed.exitConfirmed && result.status === 'completed')
      result = await verifiedReview(workspaces, review, result);
    const exitConfirmed = run.conclude(result, closed.exitConfirmed);
    settleTurn(store, sessions, { id, runId: claim.runId, review }, result, exitConfirmed);
  }
  return result;
}
