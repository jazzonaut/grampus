// Task state folded from the event log. The driver, `grampus status` and the dashboard all read the same
// fold, so what is shown is exactly what the driver will act on.
import type { Recipe } from '../domain/recipe.js';
import type { DispatchMeasurement } from '../measure/usage.js';
import type { Finding, ReviewReport } from '../domain/review.js';
import type {
  CheckResult,
  CommandKind,
  GuardResult,
  LaunchRecord,
  Stage,
  StoredEvent,
  UserCommand,
} from '../domain/events.js';
import type { CheckDefinition } from '../domain/spec.js';

export interface DispatchRecord {
  dispatchId: string;
  /** When the start was requested, before Orca injected the prompt: the start of this dispatch's activity. */
  requestedAt: string;
  startedAt: string;
  reusedHandle: string | null;
  launch: LaunchRecord | null;
  settled: { outcome: 'succeeded' | 'failed'; subject: string; body: string; at: string } | null;
  exited: boolean;
}

export interface StageRecord {
  key: string;
  stage: Stage;
  round: number;
  orcaTaskId: string;
  createdAt: string;
  dispatches: DispatchRecord[];
  startFailure: { state: string; error: string; dispatchId: string | null } | null;
  /** Start attempts so far, successful or not; numbers each attempt's request id. */
  attempts: number;
}

export interface SpecVersion {
  version: number;
  key: string;
  hash: string;
  path: string;
  checks: CheckDefinition[];
  protected: string[];
  at: string;
}

export interface ReviewRecord {
  round: number;
  sha: string;
  report: ReviewReport | null;
  blocking: Finding[];
  downgraded: Finding[];
  error: string | null;
}

export interface Attention {
  reason: string;
  detail: string;
  options: CommandKind[];
  since: string;
}

export interface TaskState {
  taskId: string;
  title: string;
  request: string;
  repoPath: string;
  recipe: Recipe;
  createdAt: string;
  workspace: { worktreeId: string; path: string; baseSha: string; driverTerminal: string } | null;
  runId: string | null;
  requests: Map<string, string>;
  /** When each Orca request id was first recorded. */
  requestTimes: Map<string, string>;
  stages: Map<string, StageRecord>;
  specs: SpecVersion[];
  rejectedSpecs: Map<string, string>;
  specReviews: Map<number, { report: ReviewReport | null; error: string | null }>;
  gate: { gateId: string; orcaTaskId: string; resolution: string | null } | null;
  applied: Set<string>;
  commands: UserCommand[];
  /** Commands the driver refused, with the reason, oldest first. */
  refusals: { kind: CommandKind; reason: string; at: string }[];
  /** Orca refused to continue a worker conversation once; later stages start fresh workers. */
  reuseUnsupported: boolean;
  /** Orca message ids already recorded, so a replayed delivery is not recorded twice. */
  messages: Set<string>;
  questions: Map<string, { key: string | null; subject: string; body: string; at: string; answered: boolean }>;
  testsFirst: { sha: string; files: string[] } | null;
  baseline: { sha: string; results: CheckResult[] } | null;
  verify: Map<number, { sha: string; results: CheckResult[] }>;
  guard: Map<number, { fromSha: string; sha: string; guard: GuardResult }>;
  reviews: Map<number, ReviewRecord>;
  decisions: Map<number, { decision: 'repair' | 'escalate' | 'ready'; reasons: string[] }>;
  attention: Attention | null;
  finished: { outcome: 'accepted' | 'abandoned'; sha: string | null; override: boolean; at: string } | null;
  released: boolean;
  /** Per-dispatch models, tokens and times, recorded when the task finishes. */
  measurements: DispatchMeasurement[] | null;
  lastStop: { reason: string; at: string } | null;
}

/** Fold a task's events into its state. */
export function foldEvents(events: readonly StoredEvent[]): TaskState {
  const created = events.find(event => event.type === 'task.created');
  if (created?.type !== 'task.created') throw new Error('The task log has no task.created event.');
  const state: TaskState = {
    taskId: created.taskId,
    title: created.title,
    request: created.request,
    repoPath: created.repoPath,
    recipe: created.recipe,
    createdAt: created.at,
    workspace: null,
    runId: null,
    requests: new Map(),
    requestTimes: new Map(),
    stages: new Map(),
    specs: [],
    rejectedSpecs: new Map(),
    specReviews: new Map(),
    gate: null,
    applied: new Set(),
    commands: [],
    messages: new Set(),
    reuseUnsupported: false,
    refusals: [],
    questions: new Map(),
    testsFirst: null,
    baseline: null,
    verify: new Map(),
    guard: new Map(),
    reviews: new Map(),
    decisions: new Map(),
    attention: null,
    finished: null,
    released: false,
    measurements: null,
    lastStop: null,
  };
  for (const event of events) applyEvent(state, event);
  return state;
}

type Handlers = { [K in StoredEvent['type']]: (state: TaskState, event: Extract<StoredEvent, { type: K }>) => void };

const ignore = () => undefined;

/** One handler per event type; the mapped type makes a missing event type a compile error. */
const handlers: Handlers = {
  'log.header': ignore,
  'task.created': ignore,
  'workspace.created': (state, event) => {
    state.workspace = {
      worktreeId: event.worktreeId,
      path: event.path,
      baseSha: event.baseSha,
      driverTerminal: event.driverTerminal,
    };
  },
  'driver.started': state => {
    state.lastStop = null;
  },
  'driver.stopped': (state, event) => {
    state.lastStop = { reason: event.reason, at: event.at };
  },
  'orca.requested': (state, event) => {
    state.requests.set(event.key, event.requestId);
    state.requestTimes.set(event.key, event.at);
  },
  'run.created': (state, event) => {
    state.runId = event.runId;
  },
  'stage.created': (state, event) => {
    state.stages.set(event.key, {
      key: event.key,
      stage: event.stage,
      round: event.round,
      orcaTaskId: event.orcaTaskId,
      createdAt: event.at,
      dispatches: [],
      startFailure: null,
      attempts: 0,
    });
  },
  'stage.started': (state, event) => {
    const stage = requireStage(state, event.key);
    stage.startFailure = null;
    stage.attempts += 1;
    stage.dispatches.push({
      dispatchId: event.dispatchId,
      requestedAt:
        state.requestTimes.get(`${event.key}:start:${stage.attempts}:fresh`) ??
        state.requestTimes.get(`${event.key}:start:${stage.attempts}`) ??
        event.at,
      startedAt: event.at,
      reusedHandle: event.reusedHandle,
      launch: event.launch,
      settled: null,
      exited: false,
    });
  },
  'stage.reuse_refused': state => {
    state.reuseUnsupported = true;
  },
  'stage.start_failed': (state, event) => {
    const stage = requireStage(state, event.key);
    stage.startFailure = { state: event.state, error: event.error, dispatchId: event.dispatchId };
    stage.attempts += 1;
  },
  'stage.settled': (state, event) => {
    state.messages.add(event.messageId);
    const dispatch = requireDispatch(state, event.key, event.dispatchId);
    dispatch.settled = { outcome: event.outcome, subject: event.subject, body: event.body, at: event.at };
  },
  'stage.exited': (state, event) => {
    requireDispatch(state, event.key, event.dispatchId).exited = true;
  },
  'worker.message': (state, event) => {
    state.messages.add(event.messageId);
    if (event.kind === 'question')
      state.questions.set(event.messageId, {
        key: event.key,
        subject: event.subject,
        body: event.body,
        at: event.at,
        answered: false,
      });
  },
  'gate.created': (state, event) => {
    state.gate = { gateId: event.gateId, orcaTaskId: event.orcaTaskId, resolution: null };
  },
  'gate.resolved': (state, event) => {
    if (state.gate) state.gate.resolution = event.resolution;
  },
  'spec.recorded': (state, event) => {
    state.specs.push({
      version: event.version,
      key: event.key,
      hash: event.hash,
      path: event.path,
      checks: event.checks,
      protected: event.protected,
      at: event.at,
    });
  },
  'spec.rejected': (state, event) => {
    state.rejectedSpecs.set(event.key, event.error);
  },
  'spec_review.recorded': (state, event) => {
    state.specReviews.set(event.specVersion, { report: event.report, error: event.error });
  },
  'tests.recorded': (state, event) => {
    state.testsFirst = { sha: event.sha, files: event.files };
  },
  'checks.recorded': (state, event) => {
    if (event.phase === 'baseline') state.baseline = { sha: event.sha, results: event.results };
    else state.verify.set(event.round, { sha: event.sha, results: event.results });
  },
  'guard.recorded': (state, event) => {
    state.guard.set(event.round, { fromSha: event.fromSha, sha: event.sha, guard: event.guard });
  },
  'review.recorded': (state, event) => {
    const { round, sha, report, blocking, downgraded, error } = event;
    state.reviews.set(round, { round, sha, report, blocking, downgraded, error });
  },
  'command.applied': (state, event) => {
    state.applied.add(event.command.id);
    state.commands.push(event.command);
    if (event.command.kind === 'reply') {
      const question = state.questions.get(event.command.messageId);
      if (question) question.answered = true;
      return;
    }
    state.attention = null;
  },
  'command.refused': (state, event) => {
    state.applied.add(event.command.id);
    state.refusals.push({ kind: event.command.kind, reason: event.reason, at: event.at });
  },
  'round.decided': (state, event) => {
    state.decisions.set(event.round, { decision: event.decision, reasons: event.reasons });
  },
  'attention.needed': (state, event) => {
    state.attention = { reason: event.reason, detail: event.detail, options: event.options, since: event.at };
  },
  'workers.released': state => {
    state.released = true;
  },
  'usage.recorded': (state, event) => {
    state.measurements = event.measurements;
  },
  'task.finished': (state, event) => {
    state.finished = { outcome: event.outcome, sha: event.sha, override: event.override, at: event.at };
    state.attention = null;
  },
};

/** Apply one event to the state in place. */
export function applyEvent(state: TaskState, event: StoredEvent): void {
  (handlers[event.type] as (state: TaskState, event: StoredEvent) => void)(state, event);
}

function requireStage(state: TaskState, key: string): StageRecord {
  const stage = state.stages.get(key);
  if (!stage) throw new Error(`The task log refers to unknown stage ${key}.`);
  return stage;
}

function requireDispatch(state: TaskState, key: string, dispatchId: string): DispatchRecord {
  const dispatch = requireStage(state, key).dispatches.find(item => item.dispatchId === dispatchId);
  if (!dispatch) throw new Error(`The task log refers to unknown dispatch ${dispatchId} of ${key}.`);
  return dispatch;
}

/** The current (latest) dispatch of a stage, if any. */
export function currentDispatch(stage: StageRecord | undefined): DispatchRecord | null {
  return stage?.dispatches.at(-1) ?? null;
}

/** Stage key for a stage and round, e.g. `build:0`, `repair:2`, `spec:1`. */
export function stageKey(stage: Stage, round: number): string {
  return `${stage}:${round}`;
}

/** Repair rounds the user has granted beyond the recipe through `continue`. */
export function grantedRounds(state: TaskState): number {
  return state.commands.filter(command => command.kind === 'continue').length;
}
