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
  TaskEvent,
  TaskOutcome,
  UserCommand,
} from '../domain/events.js';
import type { AcceptanceScenario, CheckDefinition } from '../domain/spec.js';
import type { CodeReference, Explanation, ExplanationAnswer } from '../domain/explanation.js';

export interface DispatchRecord {
  dispatchId: string;
  /** When the start was requested, before Orca injected the prompt: the start of this dispatch's activity. */
  requestedAt: string;
  startedAt: string;
  reusedHandle: string | null;
  launch: LaunchRecord | null;
  settled: { outcome: 'succeeded' | 'failed'; subject: string; body: string; at: string } | null;
  exited: boolean;
  /** Grampus stopped this worker on purpose; it also counts as exited. */
  stopped: boolean;
}

/**
 * A worker's question. Orca closes a question once the dispatch that asked it ends, so a question
 * recorded late, such as by a driver that restarted while the worker finished on its default, can be
 * closed without an answer.
 */
export interface QuestionRecord {
  key: string | null;
  /** The dispatch that asked, null when the message came from no known stage. */
  dispatchId: string | null;
  subject: string;
  body: string;
  at: string;
  answered: boolean;
  answeredAt?: string;
  /** The asking dispatch has ended, so Orca refuses any answer. */
  closed: boolean;
}

/** Whether a question still waits for the user. */
export function isOpen(question: QuestionRecord): boolean {
  return !question.answered && !question.closed;
}

/** Questions under automatic investigation are not user interruptions; escalation gets a fresh time. */
export function userQuestions(state: TaskState): [string, QuestionRecord][] {
  if (state.finished) return [];
  const policy = state.recipe.delivery;
  return [...state.questions].flatMap(([id, question]) => {
    if (!isOpen(question)) return [];
    const assessed = state.questionAssessments.get(id);
    const automatic = policy?.mode === 'unattended' && !question.key?.startsWith('question:');
    if (automatic && !assessed && state.questionAssessments.size < policy.questionResolutions) return [];
    if (automatic && assessed?.disposition === 'answer') return [];
    return [[id, { ...question, at: assessed?.at ?? question.at }] as [string, QuestionRecord]];
  });
}

/** Both explicit approval and recorded mandate approval bind the same exact spec version. */
export function approvedSpecVersion(state: TaskState): number | null {
  if (state.inherited) return 1;
  const manual = state.commands.findLast(command => command.kind === 'approve');
  const automatic = [...state.policyDecisions.values()].filter(item => item.action === 'approve-spec').at(-1);
  return Math.max(manual?.kind === 'approve' ? manual.specVersion : 0, automatic?.specVersion ?? 0) || null;
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
  acceptance: AcceptanceScenario[];
  protected: string[];
  at: string;
}

export interface ReviewRecord {
  specVersion: number;
  round: number;
  sha: string;
  report: ReviewReport | null;
  blocking: Finding[];
  downgraded: Finding[];
  error: string | null;
}

/** The polish pass of one ready round, filled in as its steps are recorded. */
export interface PolishRecord {
  round: number;
  restored?: string;
  checked: { specVersion: number; fromSha: string; sha: string; guard: GuardResult; results: CheckResult[] } | null;
  decided: Omit<Extract<TaskEvent, { type: 'polish.decided' }>, 'type' | 'round'> | null;
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
  policyDecisions: Map<string, Extract<TaskEvent, { type: 'policy.decided' }>>;
  createdAt: string;
  /** `driverTerminal` is the Orca terminal of the latest driver: the one `grampus new` opened, until a driver starts elsewhere. */
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
  questions: Map<string, QuestionRecord>;
  questionAssessments: Map<string, Extract<StoredEvent, { type: 'question.assessed' }>>;
  testsFirst: { sha: string; files: string[] } | null;
  testBaseline: Extract<TaskEvent, { type: 'tests.baseline' }> | null;
  inheritedTests: Extract<TaskEvent, { type: 'tests.inherited' }> | null;
  setup: {
    configuration: Extract<TaskEvent, { type: 'setup.configured' }> | null;
    attempts: number;
    results: Extract<TaskEvent, { type: 'setup.recorded' }>[];
  };
  /** Checks of each spec version, run at the base commit while it awaited approval. */
  specChecks: Map<number, { specVersion: number; sha: string; results: CheckResult[] }>;
  baseline: { specVersion: number; sha: string; results: CheckResult[] } | null;
  verify: Map<number, { specVersion: number; sha: string; results: CheckResult[] }>;
  guard: Map<number, { specVersion: number; fromSha: string; sha: string; guard: GuardResult }>;
  reviews: Map<number, ReviewRecord>;
  decisions: Map<
    number,
    { sha: string; specVersion: number; decision: 'repair' | 'escalate' | 'ready'; reasons: string[] }
  >;
  polish: Map<number, PolishRecord>;
  attention: Attention | null;
  finished: { outcome: TaskOutcome; sha: string | null; override: boolean; at: string } | null;
  /** The comparison this task is an entry of. */
  comparisonId: string | null;
  /** The shared spec this entry inherited instead of writing its own. */
  inherited: { fromTask: string; fromVersion: number } | null;
  released: boolean;
  releasedDispatches: Set<string>;
  /** Set by `grampus merge` after acceptance. */
  merged: { branch: string; sha: string } | null;
  /** Per-dispatch models, tokens and times, recorded when the task finishes. */
  measurements: DispatchMeasurement[] | null;
  lastStop: { reason: string; at: string } | null;
  explanations: Map<
    string,
    {
      commandId: string;
      baseSha: string;
      candidateSha: string;
      specVersion: number;
      explanation: Explanation | null;
      error: string | null;
      at: string;
    }
  >;
  answers: {
    commandId: string;
    baseSha: string;
    candidateSha: string;
    specVersion: number;
    question: string;
    groupId: string | null;
    reference: CodeReference | null;
    answer: ExplanationAnswer | null;
    error: string | null;
    at: string;
  }[];
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
    policyDecisions: new Map(),
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
    questionAssessments: new Map(),
    testsFirst: null,
    testBaseline: null,
    inheritedTests: null,
    setup: { configuration: null, attempts: 0, results: [] },
    specChecks: new Map(),
    baseline: null,
    verify: new Map(),
    guard: new Map(),
    reviews: new Map(),
    decisions: new Map(),
    polish: new Map(),
    attention: null,
    finished: null,
    released: false,
    releasedDispatches: new Set(),
    merged: null,
    measurements: null,
    lastStop: null,
    explanations: new Map(),
    answers: [],
    comparisonId: created.comparison?.comparisonId ?? null,
    inherited: null,
  };
  for (const event of events) applyEvent(state, event);
  return state;
}

type Handlers = { [K in StoredEvent['type']]: (state: TaskState, event: Extract<StoredEvent, { type: K }>) => void };

const ignore = () => undefined;

/** One handler per event type; the mapped type makes a missing event type a compile error. */
const handlers: Handlers = {
  'policy.decided': (state, event) => {
    state.policyDecisions.set(event.key, event);
  },
  'budget.checked': ignore,
  'review.workspace': ignore,
  'review.preparing': ignore,
  'review.probe': ignore,
  'question.assessed': (state, event) => {
    state.questionAssessments.set(event.messageId, event);
  },
  'question.answered': (state, event) => {
    const question = state.questions.get(event.messageId);
    if (question) {
      question.answered = true;
      question.answeredAt = event.at;
    }
  },
  'tests.inherited': (state, event) => {
    state.inheritedTests = event;
  },
  'tests.baseline': (state, event) => {
    state.testBaseline = event;
  },
  'setup.configured': (state, event) => {
    state.setup.configuration = event;
  },
  'setup.started': (state, event) => {
    state.setup.attempts = event.attempt;
  },
  'setup.recorded': (state, event) => {
    state.setup.results.push(event);
  },
  'log.header': ignore,
  'explanation.recorded': (state, event) => {
    if (event.explanation || !state.explanations.get(event.candidateSha)?.explanation)
      state.explanations.set(event.candidateSha, {
        commandId: event.commandId,
        baseSha: event.baseSha,
        candidateSha: event.candidateSha,
        specVersion: event.specVersion,
        explanation: event.explanation,
        error: event.error,
        at: event.at,
      });
  },
  'answer.recorded': (state, event) => {
    state.answers.push({
      commandId: event.commandId,
      baseSha: event.baseSha,
      candidateSha: event.candidateSha,
      specVersion: event.specVersion,
      question: event.question,
      groupId: event.groupId,
      reference: event.reference,
      answer: event.answer,
      error: event.error,
      at: event.at,
    });
  },
  'task.created': ignore,
  'workspace.created': (state, event) => {
    state.workspace = {
      worktreeId: event.worktreeId,
      path: event.path,
      baseSha: event.baseSha,
      driverTerminal: event.driverTerminal,
    };
  },
  'driver.started': (state, event) => {
    state.lastStop = null;
    // A driver resumed in a new tab runs there from now on.
    if (state.workspace && event.terminal) state.workspace.driverTerminal = event.terminal;
  },
  'driver.stopped': (state, event) => {
    state.lastStop = { reason: event.reason, at: event.at };
  },
  'orca.busy': ignore,
  'orca.room': ignore,
  'orca.uncertain': ignore,
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
      stopped: false,
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
    closeQuestions(state, event.dispatchId);
  },
  'stage.exited': (state, event) => {
    requireDispatch(state, event.key, event.dispatchId).exited = true;
    closeQuestions(state, event.dispatchId);
  },
  // A stopped worker has ended like an exited one: it will not report.
  'stage.stopped': (state, event) => {
    const dispatch = requireDispatch(state, event.key, event.dispatchId);
    dispatch.exited = true;
    dispatch.stopped = true;
    closeQuestions(state, event.dispatchId);
  },
  'worker.message': (state, event) => {
    state.messages.add(event.messageId);
    if (event.kind === 'question')
      state.questions.set(event.messageId, {
        key: event.key,
        dispatchId: (event.key && state.stages.get(event.key)?.dispatches.at(-1)?.dispatchId) ?? null,
        subject: event.subject,
        body: event.body,
        at: event.at,
        answered: false,
        closed: false,
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
      acceptance: event.acceptance,
      protected: event.protected,
      at: event.at,
    });
  },
  'spec.inherited': (state, event) => {
    state.specs.push({
      version: 1,
      key: 'inherited',
      hash: event.hash,
      path: event.path,
      checks: event.checks,
      acceptance: event.acceptance,
      protected: event.protected,
      at: event.at,
    });
    state.inherited = { fromTask: event.fromTask, fromVersion: event.fromVersion };
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
    const run = { specVersion: event.specVersion, sha: event.sha, results: event.results };
    if (event.phase === 'spec') state.specChecks.set(event.round, run);
    else if (event.phase === 'baseline') state.baseline = run;
    else state.verify.set(event.round, run);
  },
  'guard.recorded': (state, event) => {
    state.guard.set(event.round, {
      specVersion: event.specVersion,
      fromSha: event.fromSha,
      sha: event.sha,
      guard: event.guard,
    });
  },
  'review.recorded': (state, event) => {
    const { round, specVersion, sha, report, blocking, downgraded, error } = event;
    state.reviews.set(round, { round, specVersion, sha, report, blocking, downgraded, error });
  },
  'command.applied': (state, event) => {
    state.applied.add(event.command.id);
    state.commands.push(event.command);
    if (event.command.kind === 'reply' || event.command.kind === 'explain' || event.command.kind === 'ask') {
      if (event.command.kind === 'reply') {
        const question = state.questions.get(event.command.messageId);
        if (question) {
          question.answered = true;
          question.answeredAt = event.at;
        }
      }
      return;
    }
    state.attention = null;
  },
  'command.refused': (state, event) => {
    state.applied.add(event.command.id);
    state.refusals.push({ kind: event.command.kind, reason: event.reason, at: event.at });
  },
  'round.decided': (state, event) => {
    state.decisions.set(event.round, {
      sha: event.sha,
      specVersion: event.specVersion,
      decision: event.decision,
      reasons: event.reasons,
    });
  },
  'polish.checked': (state, { round, specVersion, fromSha, sha, guard, results }) => {
    polishRecord(state, round).checked = { specVersion, fromSha, sha, guard, results };
  },
  'polish.decided': (
    state,
    { round, specVersion, fromSha, sha, kept, outcome, report, maintenance, reasons, review, before, after },
  ) => {
    polishRecord(state, round).decided = {
      specVersion,
      fromSha,
      sha,
      kept,
      outcome,
      report,
      maintenance,
      reasons,
      review,
      before,
      after,
    };
  },
  'polish.restored': (state, event) => {
    polishRecord(state, event.round).restored = event.sha;
  },
  'attention.needed': (state, event) => {
    state.attention = { reason: event.reason, detail: event.detail, options: event.options, since: event.at };
  },
  'attention.withdrawn': (state, event) => {
    if (state.attention?.reason === event.reason) state.attention = null;
  },
  'workers.released': (state, event) => {
    state.released = true;
    for (const dispatchId of event.released) state.releasedDispatches.add(dispatchId);
  },
  'task.merged': (state, event) => {
    state.merged = { branch: event.branch, sha: event.sha };
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

function polishRecord(state: TaskState, round: number): PolishRecord {
  const existing = state.polish.get(round);
  if (existing) return existing;
  const created: PolishRecord = { round, checked: null, decided: null };
  state.polish.set(round, created);
  return created;
}

function closeQuestions(state: TaskState, dispatchId: string): void {
  for (const question of state.questions.values()) if (question.dispatchId === dispatchId) question.closed = true;
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
