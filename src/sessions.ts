import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { connectAgent } from './agents/index.js';
import { Workspaces } from './workspaces.js';
import { claimExecution, requireExecutionLease, settleExecution, stopExecution, type Execution } from './execution-state.js';
import type { Task } from './workflow.js';
import { parseReply, type AgentEvent, type AgentSession, type Connector, type Provider, type Reply, type TurnResult } from './agents/types.js';

export interface Session {
  id: string;
  provider: Provider;
  providerSessionId: string | null;
  model: string | null;
  cwd: string;
  phase: 'idle' | 'running' | 'awaiting_answer' | 'stop_requested' | 'interrupted' | 'failed' | 'recovery_required';
  lastReply: Reply | null;
  run: { id: string; controllerPid: number; host: string; providerPid: number | null } | null;
}

export class Sessions {
  constructor(private readonly store: Store) {}
  get(id: string): Session { return this.store.session<Session>(id); }

  create(provider: Provider, cwd: string, model: string | null = null): Session {
    if (!['codex', 'claude'].includes(provider)) throw new Error('Provider must be codex or claude');
    const directory = resolve(cwd);
    if (!statSync(directory).isDirectory()) throw new Error('Session directory must exist');
    const session: Session = { id: randomUUID(), provider, providerSessionId: null, model, cwd: directory, phase: 'idle', lastReply: null, run: null };
    this.store.transaction(() => { this.store.saveSession(session.id, session); this.store.appendSession(session.id, 'session.created', session); });
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

  claim(id: string, prompt: string, answers?: Record<string, string>): { session: Session; prompt: string; runId: string } {
    if (answers !== undefined && (!answers || typeof answers !== 'object' || Array.isArray(answers))) throw new Error('Answers must be a JSON object');
    return this.change(id, session => {
      if (['running', 'stop_requested', 'recovery_required'].includes(session.phase)) throw new Error('Session already owned or needs recovery; no automatic replay');
      if (session.phase === 'awaiting_answer') {
        const questions = session.lastReply!.questions;
        if (!answers || Object.keys(answers).length !== questions.length || questions.some(q => typeof answers[q.id] !== 'string' || !answers[q.id]!.trim())) {
          throw new Error('Answer every pending question by its id');
        }
        prompt = `User answers to the pending questions:\n${JSON.stringify(answers)}`;
        this.store.appendSession(id, 'questions.answered', { answers });
      } else if (answers) throw new Error('Session has no pending questions');
      if (!prompt.trim()) throw new Error('Prompt must not be empty');
      session.run = { id: randomUUID(), controllerPid: process.pid, host: hostname(), providerPid: null };
      claimExecution(this.store, session, session.run.id);
      const execution = this.store.executionForSession<Execution>(id);
      if (execution) {
        const task = this.store.get<Task>(execution.taskId);
        prompt = `Approved task context (conversation only; do not claim repository execution or completion):\n${JSON.stringify({
          brief: task.brief, version: execution.version, attemptId: execution.attemptId, role: execution.role, artifact: execution.artifact,
        })}\n\nUser turn:\n${prompt}`;
      }
      session.phase = 'running';
      this.store.appendSession(id, 'turn.requested', { runId: session.run.id, prompt, autoRetries: 0 });
      return { session: structuredClone(session), prompt, runId: session.run.id };
    });
  }

  event(id: string, runId: string, event: AgentEvent): boolean {
    return this.change(id, session => {
      if (session.run?.id !== runId || !['running', 'stop_requested'].includes(session.phase)) {
        this.store.appendSession(id, 'event.ignored', { runId, eventType: event.type }); return false;
      }
      const execution = requireExecutionLease(this.store, session, runId);
      if (event.type === 'session.connected') {
        const data = event.data as { providerSessionId: string; model: string | null };
        if (typeof data.providerSessionId !== 'string' || !data.providerSessionId) throw new Error('Missing provider session identity');
        if (session.providerSessionId && session.providerSessionId !== data.providerSessionId) throw new Error('Provider session identity changed');
        session.providerSessionId = data.providerSessionId;
        if (data.model) session.model = data.model;
        if (execution?.role === 'implementation' && data.model) {
          const task = this.store.get<Task>(execution.taskId);
          if (task.attempt?.id === execution.attemptId && task.version === execution.version) {
            task.attempt.agent.model = data.model;
            this.store.save(task.id, task);
            this.store.append(task.id, task.version, 'execution.model_observed', { executionId: execution.id, model: data.model });
          }
        }
      }
      if (event.type === 'process.started') {
        const pid = (event.data as { pid?: number }).pid;
        if (pid && Number.isSafeInteger(pid) && pid > 0) session.run.providerPid = pid;
      }
      this.store.appendSession(id, event.type, { runId, data: event.data });
      return true;
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
        this.store.appendSession(id, 'result.ignored', { runId }); return;
      }
      this.store.appendSession(id, 'turn.result', { runId, result, exitConfirmed });
      if (!exitConfirmed) {
        settleExecution(this.store, session, runId, result.status, false);
        session.phase = 'recovery_required'; return;
      }
      this.store.appendSession(id, 'process.exit_confirmed', { runId });
      if (session.phase === 'stop_requested' || result.status === 'interrupted') session.phase = 'interrupted';
      else if (result.status === 'failed') session.phase = 'failed';
      else {
        session.lastReply = parseReply(result.reply);
        session.phase = session.lastReply.kind === 'question' ? 'awaiting_answer' : 'idle';
      }
      settleExecution(this.store, session, runId, session.phase === 'interrupted' ? 'interrupted' : result.status, true);
      session.run = null;
    });
  }

  recover(id: string, alive = processAlive): void {
    this.change(id, session => {
      if (!session.run || !['running', 'stop_requested', 'recovery_required'].includes(session.phase)) throw new Error('Session does not need recovery');
      if (session.run.host !== hostname()) throw new Error('Reconcile this session on its execution host');
      if (alive(session.run.controllerPid)) throw new Error('Previous controller is still alive or unverifiable');
      if (session.run.providerPid === null || alive(session.run.providerPid)) throw new Error('Provider exit is unconfirmed; do not start a duplicate session');
      this.store.appendSession(id, 'session.recovered', { runId: session.run.id, evidence: 'Controller and recorded provider PIDs no longer exist', replayed: false });
      settleExecution(this.store, session, session.run.id, 'interrupted', true);
      session.phase = 'interrupted';
      session.run = null;
    });
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export interface RunOptions {
  timeoutMs?: number;
  interruptAfterMs?: number;
  signal?: AbortSignal;
  answers?: Record<string, string>;
  onEvent?: (event: AgentEvent) => void;
}

/** Each CLI invocation owns one process, closes it, and retains a resumable provider id. */
export async function runSession(store: Store, id: string, prompt: string, options: RunOptions = {}, connect: Connector = connectAgent, workspaces = new Workspaces(store)): Promise<TurnResult> {
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600_000) throw new Error('Timeout must be between 100 and 600000 ms');
  if (options.interruptAfterMs !== undefined && (!Number.isSafeInteger(options.interruptAfterMs) || options.interruptAfterMs < 1)) throw new Error('Interrupt delay must be a positive integer');
  const sessions = new Sessions(store);
  const claim = sessions.claim(id, prompt, options.answers);
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
  const stopSignal = new Promise<void>(resolve => { stopNow = resolve; });
  const requestStop = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    sessions.stop(id, claim.runId, reason);
    if (agent) void agent.interrupt().catch(() => {});
    else connectionAbort.abort();
    graceTimer = setTimeout(stopNow, 5000);
  };
  const aborted = () => requestStop('user interrupt');
  const emit = (event: AgentEvent): void => {
    if (event.type === 'process.started') processStarted = true;
    if (event.type === 'process.exit_confirmed') connectorClosed = true;
    if (!sessions.event(id, claim.runId, event)) return;
    options.onEvent?.(event);
    if (event.type === 'turn.started' && options.interruptAfterMs && !interruptTimer) {
      interruptTimer = setTimeout(() => requestStop('scheduled probe interrupt'), options.interruptAfterMs);
    }
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  timeoutTimer = setTimeout(() => requestStop('turn timeout'), timeout);
  let result: TurnResult = { status: 'failed', reply: null, usage: null, error: 'Turn did not complete' };
  let exitConfirmed = false;
  try {
    const execution = store.executionForSession<Execution>(id);
    if (execution) {
      const inspected = await workspaces.inspect(execution.workspaceId);
      if (!inspected.taskCurrent) throw new Error('Execution task version changed before dispatch');
      if (stopped) throw new Error('Interrupted before provider connection');
    }
    connectionPending = true;
    const connection = Promise.resolve().then(() => connect(claim.session.provider, { cwd: claim.session.cwd, providerSessionId: claim.session.providerSessionId,
      model: claim.session.model, signal: connectionAbort.signal, emit })).then(value => {
      connectionPending = false; agent = value; connectionFinished = true; return value;
    }, error => { connectionPending = false; throw error; });
    // If startup outlives the deadline, close it when it eventually returns. Never send a prompt.
    void connection.then(async value => { if (stopped) await value.close(); }).catch(() => {});
    const connected = await Promise.race([connection, stopSignal.then(() => null)]);
    if (connected && !stopped) {
      result = await Promise.race([connected.turn(claim.prompt), stopSignal.then((): TurnResult => ({ status: 'interrupted', reply: null, usage: null, error: 'Interrupted before a final provider result' }))]);
      if (result.status === 'completed') result.reply = parseReply(result.reply);
    } else result = { status: 'interrupted', reply: null, usage: null, error: 'Interrupted during connection' };
  } catch (error) {
    result = { status: stopped ? 'interrupted' : 'failed', reply: null, usage: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(interruptTimer); clearTimeout(timeoutTimer); clearTimeout(graceTimer);
    options.signal?.removeEventListener('abort', aborted);
    try {
      if (agent) { await (agent as AgentSession).close(); exitConfirmed = true; }
      else exitConfirmed = connectorClosed || (!processStarted && !connectionPending);
    } catch (error) { result = { ...result, status: 'failed', error: `Process shutdown unconfirmed: ${error instanceof Error ? error.message : String(error)}` }; }
    if (stopped) { result.status = 'interrupted'; result.reply = null; }
    if (!connectorClosed && (connectionPending || (!connectionFinished && stopped && processStarted))) exitConfirmed = false;
    sessions.settle(id, claim.runId, result, exitConfirmed);
  }
  return result;
}
