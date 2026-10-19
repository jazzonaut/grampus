import type { RepositoryAccess } from '../repository/repository-tools.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { Session, TurnStage } from '../persistence/records.js';
import { processLimits } from '../config/limits.js';
import { agentTimeout } from './agent-timeout.js';
import { connectAgent } from '../providers/index.js';
import { Workspaces } from '../repository/workspaces.js';
import { claimExecution, requireExecutionLease, settleExecution, stopExecution } from './execution-state.js';
import { Workflow, activeSlice, activeCriteria, type Task } from '../domain/workflow.js';
import { currentProcessStartedAt, inspectProcess } from '../process/process-identity.js';
import { processAlive as ownedProcessAlive } from '../verification/check-recovery.js';
import { captureRepository, reviewContext } from '../repository/repository-evidence.js';
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

export type { Session } from '../persistence/records.js';

// Adapter events whose data changes session state. Adapters are in-process, but their data repeats
// what the provider reported, so it is validated before it becomes session identity.
const connectedEventSchema = z.object({ providerSessionId: z.string().min(1), model: z.string().nullish() });
const processStartedEventSchema = z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export class Sessions {
  constructor(private readonly store: Store) {}
  get(id: string): Session {
    return this.store.session(id);
  }

  create(provider: Provider, cwd: string, model: string | null = null): Session {
    if (!['codex', 'claude'].includes(provider)) throw new Error('Provider must be codex or claude');
    const directory = resolve(cwd);
    if (!statSync(directory).isDirectory()) throw new Error('Session directory must exist');
    const session: Session = {
      id: randomUUID(),
      provider,
      providerSessionId: null,
      model,
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
    return this.change(id, session => {
      if (session.deletedAt) throw new Error('This planning conversation was deleted');
      if (editing) {
        if (session.providerSessionId && session.mode !== 'editing')
          throw new Error('Native editing requires a fresh session or an existing editing session');
        const execution = this.store.executionForSession(id);
        if (execution?.role !== 'implementation')
          throw new Error('Native editing requires an implementation execution');
        session.mode = 'editing';
      } else if (session.mode === 'editing') throw new Error('Use execution-implement to continue an editing session');
      if (['running', 'stop_requested', 'recovery_required'].includes(session.phase))
        throw new Error('Session already owned or needs recovery; no automatic replay');
      if (session.phase === 'awaiting_answer') {
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
        prompt = `${prompt.trim() ? `${prompt}\n\n` : ''}User answers to the pending questions:\n${JSON.stringify(answers)}`;
        this.store.appendSession(id, 'questions.answered', { answers });
      } else if (answers) throw new Error('Session has no pending questions');
      if (!prompt.trim()) throw new Error('Prompt must not be empty');
      session.run = {
        id: randomUUID(),
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
        host: hostname(),
        providerPid: null,
        providerStartedAt: null,
        ...(trackDispatch ? { providerDispatch: 'not_requested' as const } : {}),
      };
      claimExecution(this.store, session, session.run.id, editing ? 'implementation' : 'conversation');
      const execution = this.store.executionForSession(id);
      if (execution) {
        const task = this.store.get<Task>(execution.taskId);
        prompt = `Approved task context (${editing ? 'native file editing; do not claim validation or completion' : 'conversation only; do not claim repository execution or completion'}):\n${JSON.stringify(
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
      session.phase = 'running';
      this.store.appendSession(id, 'turn.requested', {
        runId: session.run.id,
        stage: stage ?? execution?.stage ?? 'planning',
        prompt,
        autoRetries: 0,
      });
      return { session: structuredClone(session), prompt, runId: session.run.id };
    });
  }

  event(id: string, runId: string, event: AgentEvent): boolean {
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
          const task = this.store.get<Task>(execution.taskId);
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
      if (event.type === 'process.started') {
        const pid = processStartedEventSchema.safeParse(event.data).data?.pid;
        if (pid !== undefined) {
          const observed = inspectProcess(pid);
          session.run.providerPid = pid;
          session.run.providerStartedAt = observed.state === 'present' ? observed.startedAt : null;
          session.run.providerDispatch = 'requested';
        }
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

  requestConnection(id: string, runId: string): void {
    this.change(id, session => {
      if (session.run?.id !== runId || session.phase !== 'running' || session.run.providerDispatch !== 'not_requested')
        throw new Error('Provider connection ownership changed');
      session.run.providerDispatch = 'requested';
      this.store.appendSession(id, 'connection.requested', { runId });
    });
  }

  stop(id: string, runId: string, reason: string): void {
    this.change(id, session => {
      if (session.run?.id !== runId || session.phase !== 'running') return;
      stopExecution(this.store, session, runId, reason);
      session.phase = 'stop_requested';
      this.store.appendSession(id, 'stop.requested', { runId, reason });
    });
  }

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

export interface RunOptions {
  repository?: RepositoryAccess;
  timeoutMs?: number;
  interruptAfterMs?: number;
  signal?: AbortSignal;
  answers?: Record<string, string>;
  onEvent?: (event: AgentEvent) => void;
  artifactReview?: boolean;
}

/** Each CLI invocation owns one process, closes it, and retains a resumable provider id. */
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
  const reviewArtifact = review?.artifact ?? '';
  const claim = store.transaction(() => {
    if (review) {
      const session = sessions.get(id);
      new Workflow(store).record(review.taskId, {
        id: randomUUID(),
        attemptId: review.attemptId,
        version: review.version,
        artifact: reviewArtifact,
        kind: 'review',
        outcome: 'skipped',
        source: 'agent',
        summary: 'Artifact review requested; a new verified verdict is pending',
        agent: { provider: session.provider, sessionId: session.id, model: session.model ?? 'provider-default' },
        ...(review.fallbackReason ? { fallbackReason: review.fallbackReason } : {}),
      });
    }
    return sessions.claim(id, prompt, options.answers, false, true);
  });
  let agent: AgentSession | null = null;
  let stopped = false;
  let connectionFinished = false;
  let connectionPending = false;
  let connectorClosed = false;
  let processStarted = false;
  const connectionAbort = new AbortController();
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopNow!: () => void;
  const stopSignal = new Promise<void>(resolve => {
    stopNow = resolve;
  });
  const output = new OutputBuffer(text => {
    if (sessions.delta(id, claim.runId, text)) options.onEvent?.({ type: 'output.delta', data: { text } });
  });
  const requestStop = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    try {
      output.flush();
    } catch {
      /* Display-only text; the stop below is what must be journaled. */
    }
    sessions.stop(id, claim.runId, reason);
    if (agent) void agent.interrupt().catch(() => {});
    else connectionAbort.abort();
    graceTimer = setTimeout(stopNow, processLimits.stopGraceMs);
  };
  const aborted = () => requestStop('user interrupt');
  const emit = (event: AgentEvent): void => {
    const text = deltaText(event);
    if (text !== null) {
      output.add(text);
      return;
    }
    if (event.type === 'process.started') processStarted = true;
    if (event.type === 'process.exit_confirmed') connectorClosed = true;
    output.flush();
    if (!sessions.event(id, claim.runId, event)) return;
    options.onEvent?.(event);
    if (event.type === 'turn.started' && options.interruptAfterMs && !interruptTimer) {
      interruptTimer = setTimeout(() => requestStop('scheduled probe interrupt'), options.interruptAfterMs);
    }
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  if (timeout > 0) timeoutTimer = setTimeout(() => requestStop('turn timeout'), timeout);
  let result: TurnResult = { status: 'failed', reply: null, usage: null, error: 'Turn did not complete' };
  let exitConfirmed = false;
  try {
    const execution = store.executionForSession(id);
    let repository = options.repository;
    let configurationCwd = options.repository?.repo ?? claim.session.cwd;
    if (execution) {
      configurationCwd = workspaces.get(execution.workspaceId).repository;
      const inspected = await workspaces.inspect(execution.workspaceId, !review);
      if (!inspected.taskCurrent) throw new Error('Execution task version changed before dispatch');
      if (review) {
        const snapshot = await captureRepository(workspaces, review);
        claim.prompt += `\n\n${await reviewContext(store, workspaces, review, snapshot, !!claim.session.providerSessionId)}`;
        const plan = new Workflow(store).get(execution.taskId).guided?.plan;
        const checks = taskCheckEvidence(store, execution);
        claim.prompt += `\nRetained check evidence (use grampus_read_check for complete output):\n${checkEvidenceSummary(checks)}`;
        if (plan?.context.exploration)
          repository = { repo: claim.session.cwd, snapshot, references: plan.references ?? [], checks };
        emit({ type: 'review.context', data: { artifact: review.artifact, prompt: claim.prompt } });
      }
      if (stopped) throw new Error('Interrupted before provider connection');
    }
    connectionPending = true;
    const connection = Promise.resolve()
      .then(() => {
        sessions.requestConnection(id, claim.runId);
        return connect(claim.session.provider, {
          cwd: claim.session.cwd,
          providerSessionId: claim.session.providerSessionId,
          model: claim.session.model,
          configurationCwd,
          signal: connectionAbort.signal,
          emit,
          ...(repository ? { repository } : {}),
        });
      })
      .then(
        value => {
          connectionPending = false;
          agent = value;
          connectionFinished = true;
          return value;
        },
        error => {
          connectionPending = false;
          throw error;
        },
      );
    // If startup outlives the deadline, close it when it eventually returns. Never send a prompt.
    void connection
      .then(async value => {
        if (stopped) await value.close();
      })
      .catch(() => {});
    const connected = await Promise.race([connection, stopSignal.then(() => null)]);
    if (connected && !stopped) {
      result = await Promise.race([
        connected.turn(claim.prompt),
        stopSignal.then((): TurnResult => ({
          status: 'interrupted',
          reply: null,
          usage: null,
          error: 'Interrupted before a final provider result',
        })),
      ]);
      if (result.status === 'completed') result.reply = parseReply(result.reply);
    } else result = { status: 'interrupted', reply: null, usage: null, error: 'Interrupted during connection' };
  } catch (error) {
    result = {
      status: stopped ? 'interrupted' : 'failed',
      reply: null,
      usage: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(interruptTimer);
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    options.signal?.removeEventListener('abort', aborted);
    try {
      if (agent) {
        await (agent as AgentSession).close();
        exitConfirmed = true;
      } else exitConfirmed = connectorClosed || (!processStarted && !connectionPending);
    } catch (error) {
      result = {
        ...result,
        status: 'failed',
        error: `Process shutdown unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (review && exitConfirmed && result.status === 'completed') {
      try {
        if ((await captureRepository(workspaces, review)).artifact !== review.artifact)
          throw new Error('Repository changed during review');
        if (result.reply?.kind === 'review' && !result.reply.text.trim())
          throw new Error('Review requires an explicit summary');
      } catch (error) {
        result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (stopped || options.signal?.aborted) {
      result.status = 'interrupted';
      result.reply = null;
    }
    if (!connectorClosed && (connectionPending || (!connectionFinished && stopped && processStarted)))
      exitConfirmed = false;
    try {
      output.flush();
    } catch {
      /* Display-only text; settlement below records whether this run still owned the session. */
    }
    store.transaction(() => {
      const owned = sessions.get(id).run?.id === claim.runId;
      sessions.settle(id, claim.runId, result, exitConfirmed);
      if (review && exitConfirmed && owned) {
        const session = sessions.get(id);
        const verdict = result.status === 'completed' && result.reply?.kind === 'review' ? result.reply : null;
        const isReview = verdict !== null;
        const outcome =
          result.status === 'failed' || verdict?.findings.some(finding => finding.severity === 'blocking')
            ? 'failed'
            : isReview
              ? 'passed'
              : 'skipped';
        new Workflow(store).record(review.taskId, {
          id: claim.runId,
          attemptId: review.attemptId,
          version: review.version,
          artifact: reviewArtifact,
          kind: 'review',
          outcome,
          source: 'agent',
          summary: result.error ?? (result.reply?.text.trim() || 'Artifact review did not produce a review verdict'),
          agent: { provider: session.provider, sessionId: session.id, model: session.model ?? 'provider-default' },
          ...(review.fallbackReason ? { fallbackReason: review.fallbackReason } : {}),
        });
        store.appendExecution(review.id, 'review.settled', {
          runId: claim.runId,
          artifact: review.artifact,
          outcome,
          findings: result.reply?.findings ?? [],
        });
      }
    });
  }
  return result;
}
