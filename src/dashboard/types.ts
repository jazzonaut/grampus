// The dashboard's JSON contract. The server builds these views from the folded task state and the web app
// imports them as types only, so both sides agree on one definition.
import type { CommandGroup } from '../commands.js';
import type { CheckResult, CommandKind, GuardResult, Stage, StoredEvent, UserCommand } from '../domain/events.js';
import type { Recipe } from '../domain/recipe.js';
import type { Finding, ReviewReport } from '../domain/review.js';
import type { CheckDefinition } from '../domain/spec.js';
import type { Scorecard } from '../measure/report.js';
import type { TaskSummary } from '../pipeline/status.js';

/** Where a task stands, for icons, filters and the tab badge. */
export type TaskStatus = 'needs-you' | 'running' | 'stopped' | 'accepted' | 'abandoned';

export interface AttentionView {
  reason: string;
  detail: string;
  options: CommandKind[];
  since: string;
}

export interface TaskListItem {
  taskId: string;
  title: string;
  recipe: string;
  repository: { path: string; name: string };
  status: TaskStatus;
  /** One line, as `grampus status` prints it. */
  phase: string;
  needsYou: AttentionView | null;
  openQuestions: number;
  /** The latest round with a decision or verification, if any. */
  round: number | null;
  createdAt: string;
  /** Time of the latest event. */
  updatedAt: string;
  finishedAt: string | null;
}

export interface TaskList {
  asOf: string;
  tasks: TaskListItem[];
  /** Task folders whose logs could not be read, such as logs from another Grampus version. */
  unreadable: { taskId: string; error: string }[];
}

export type StepId =
  'spec' | 'spec-review' | 'approve' | 'tests' | 'baseline' | 'build' | 'verify' | 'review' | 'repair' | 'accept';
export type StepState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface PipelineStep {
  id: StepId;
  label: string;
  state: StepState;
  detail: string | null;
}

export interface SpecReviewView {
  state: 'none' | 'running' | 'done' | 'unavailable';
  report: ReviewReport | null;
  error: string | null;
}

export interface SpecView {
  version: number;
  at: string;
  path: string;
  hash: string;
  checks: CheckDefinition[];
  protected: string[];
  /** The spec text, or null when its file is missing. */
  text: string | null;
  review: SpecReviewView;
  approved: boolean;
}

export interface MessageView {
  messageId: string;
  stage: string | null;
  kind: string;
  subject: string;
  body: string;
  at: string;
  answered: boolean;
  answer: { body: string; at: string; source: UserCommand['source'] } | null;
}

export interface DispatchView {
  dispatchId: string;
  requestedAt: string;
  startedAt: string;
  agent: string | null;
  model: string | null;
  effort: string | null;
  reused: boolean;
  settled: { outcome: 'succeeded' | 'failed'; subject: string; body: string; at: string } | null;
  exited: boolean;
}

export interface StageView {
  key: string;
  stage: Stage;
  round: number;
  createdAt: string;
  dispatches: DispatchView[];
  startFailure: { state: string; error: string } | null;
}

export interface CheckRunView {
  sha: string;
  results: CheckResult[];
}

export interface ReviewView {
  sha: string;
  report: ReviewReport | null;
  blocking: Finding[];
  downgraded: Finding[];
  error: string | null;
}

export interface RoundView {
  round: number;
  /** The stage that edited this round: `build:0` or `repair:<n>`. */
  stageKey: string;
  guard: { fromSha: string; sha: string; result: GuardResult } | null;
  checks: CheckRunView | null;
  review: ReviewView | null;
  decision: { decision: 'repair' | 'escalate' | 'ready'; reasons: string[] } | null;
}

export interface CommandView {
  id: string;
  kind: CommandKind;
  at: string;
  source: UserCommand['source'];
  /** Feedback, guidance, answer or reason, when the command carries one. */
  text: string | null;
  /** The worker question a reply answers. */
  messageId: string | null;
  state: 'queued' | 'applied' | 'refused';
  reason: string | null;
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface TimelineItem {
  at: string;
  type: StoredEvent['type'];
  title: string;
  detail: string | null;
  tone: Tone;
}

export interface TaskDetail extends TaskListItem {
  request: string;
  recipeSnapshot: Recipe;
  worktree: { path: string; baseSha: string; driverTerminal: string } | null;
  runId: string | null;
  pipeline: PipelineStep[];
  /** What `grampus status` shows: the pending decision with its evidence. */
  summary: TaskSummary;
  specs: SpecView[];
  messages: MessageView[];
  stages: StageView[];
  testsFirst: { sha: string; files: string[] } | null;
  baseline: CheckRunView | null;
  rounds: RoundView[];
  commands: CommandView[];
  timeline: TimelineItem[];
  merged: { branch: string; sha: string } | null;
  finished: { outcome: 'accepted' | 'abandoned'; sha: string | null; override: boolean; at: string } | null;
  lastStop: { reason: string; at: string } | null;
}

export interface HelpView {
  groups: {
    id: CommandGroup;
    title: string;
    commands: { name: string; args: string; summary: string; detail: string | null }[];
  }[];
  globalOptions: string;
}

export interface ScorecardView extends Scorecard {
  asOf: string;
}

/** Sent over `/api/live` when task logs change. */
export interface LiveChange {
  asOf: string;
  tasks: string[];
}
