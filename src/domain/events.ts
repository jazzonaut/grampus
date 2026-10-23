// The task event log: the evidence and measurements Grampus owns, in append order. Orca owns lifecycle
// state (runs, tasks, dispatches); these events record what Grampus asked for, what it observed and what
// it decided, so a task can be resumed, reported and compared with other recipes.
import { z } from 'zod';
import { inputLimits } from '../config/limits.js';
import type { Assignment, Recipe } from './recipe.js';
import type { Finding, ReviewReport } from './review.js';
import type { MaintenanceAssessment, PolishReport } from './polish.js';
import type { CheckAssessment } from '../checks/failure.js';
import type { AcceptanceScenario, BehaviouralHarness, CheckDefinition } from './spec.js';
import type { DispatchMeasurement } from '../measure/usage.js';
import { codeReferenceSchema, type CodeReference, type Explanation, type ExplanationAnswer } from './explanation.js';

/** How a task ended. `not-selected` is a comparison entry the user did not pick; its evidence still counts. */
export type TaskOutcome = 'accepted' | 'abandoned' | 'not-selected';

/** The event log schema. Logs written with another schema are refused; there are no migrations. */
export const eventSchemaVersion = 6;

/** Pipeline stages that run as Orca workers. */
export type Stage =
  'spec' | 'spec-review' | 'tests' | 'build' | 'review' | 'repair' | 'polish' | 'polish-review' | 'explain' | 'answer';

/** The result of one check command at one commit. */
export interface CheckResult {
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Log file of the final attempt. */
  logPath: string;
  /** The check failed, was rerun once and passed: recorded as flaky and counted as passing. */
  flaky: boolean;
  passed: boolean;
}

/** What the integrity guard found between the build's starting commit and the candidate. */
export interface GuardResult {
  clean: boolean;
  commits: number;
  changedFiles: string[];
  /** Problems that fail the round: protected paths changed, tests deleted, uncommitted work, no commits. */
  violations: string[];
  /** Existing test files the round modified; shown to the reviewer. */
  modifiedTests: string[];
  /**
   * Files outside the tests that decide how checks run (runner, build or lint settings, scripts a check
   * names) which the round changed, added or deleted; shown to the reviewer and the user. Absent in
   * rounds recorded before Grampus named them, which means none were named, not none were changed.
   */
  modifiedCheckConfig?: string[];
}

/** The size of a change between two commits; binary files count as files without lines. */
export interface DiffSize {
  files: number;
  added: number;
  deleted: number;
}

/** A code review after Grampus applied its blocking rule, or why there is none. */
export interface ReviewResult {
  report: ReviewReport | null;
  blocking: Finding[];
  downgraded: Finding[];
  error: string | null;
}

/** The launch Orca reported: what was asked for and what it says ran. */
export interface LaunchRecord {
  requested: Record<string, unknown> | null;
  effective: Record<string, unknown> | null;
}

export type TaskEvent =
  | { type: 'log.header'; schema: number }
  | {
      type: 'task.created';
      taskId: string;
      title: string;
      request: string;
      repoPath: string;
      recipe: Recipe;
      /** Set for an entry of a comparison. */
      comparison?: { comparisonId: string };
    }
  | { type: 'workspace.created'; worktreeId: string; path: string; baseSha: string; driverTerminal: string }
  | {
      type: 'setup.configured';
      sha: string;
      command: CheckDefinition | null;
      source: string;
      verification: { checks: CheckDefinition[]; source: string; harness?: BehaviouralHarness };
    }
  | { type: 'setup.started'; attempt: number }
  | { type: 'setup.recorded'; attempt: number; sha: string; result: CheckResult; problems: string[] }
  | {
      type: 'driver.started';
      pid: number;
      orcaVersion: string | null;
      terminal: string | null;
      /** The installed build the driver runs; absent for a development checkout. */
      build?: string;
    }
  /** Orca turned a call away unapplied because its long-poll slots were full; the driver waits for room. */
  | { type: 'orca.busy'; detail: string }
  /** Orca took a call again after a busy spell. */
  | { type: 'orca.room'; waitedMs: number }
  /** An Orca call's outcome was unknown (Orca unreachable or silent); the driver repeats it by its request id. */
  | { type: 'orca.uncertain'; detail: string; repeat: number }
  | { type: 'orca.requested'; key: string; requestId: string }
  | { type: 'run.created'; runId: string; coordinatorHandle: string | null }
  | { type: 'stage.created'; key: string; stage: Stage; round: number; orcaTaskId: string }
  | {
      type: 'stage.started';
      key: string;
      dispatchId: string;
      assignment: Assignment | null;
      reusedHandle: string | null;
      launch: LaunchRecord | null;
    }
  /** Orca refused to continue a worker's conversation (workers in Chat UI mode cannot take a second dispatch). */
  | { type: 'stage.reuse_refused'; key: string; handle: string; error: string }
  | { type: 'stage.start_failed'; key: string; dispatchId: string | null; state: string; error: string }
  | {
      type: 'stage.settled';
      key: string;
      dispatchId: string;
      messageId: string;
      outcome: 'succeeded' | 'failed';
      subject: string;
      body: string;
    }
  | { type: 'stage.exited'; key: string; dispatchId: string }
  /** Grampus stopped a worker whose result was no longer needed, such as a spec review after the decision. */
  | { type: 'stage.stopped'; key: string; dispatchId: string; reason: string }
  | {
      type: 'worker.message';
      messageId: string;
      key: string | null;
      kind: string;
      subject: string;
      body: string;
    }
  | {
      type: 'spec.recorded';
      key: string;
      version: number;
      hash: string;
      path: string;
      checks: CheckDefinition[];
      acceptance: AcceptanceScenario[];
      protected: string[];
    }
  | { type: 'spec.rejected'; key: string; error: string }
  /** A comparison entry received the spec the user approved in its shared-mode sibling; it has no spec phase of its own. */
  | {
      type: 'spec.inherited';
      fromTask: string;
      fromVersion: number;
      hash: string;
      path: string;
      checks: CheckDefinition[];
      acceptance: AcceptanceScenario[];
      protected: string[];
    }
  | { type: 'spec_review.recorded'; specVersion: number; report: ReviewReport | null; error: string | null }
  | { type: 'gate.created'; gateId: string; orcaTaskId: string }
  | { type: 'gate.resolved'; gateId: string; resolution: string }
  | { type: 'command.applied'; command: UserCommand }
  | { type: 'command.refused'; command: UserCommand; reason: string }
  | { type: 'tests.recorded'; sha: string; files: string[] }
  | { type: 'tests.inherited'; fromTask: string; sha: string; files: string[] }
  | { type: 'tests.baseline'; specVersion: number; sha: string; assessments: CheckAssessment[] }
  | {
      type: 'checks.recorded';
      specVersion: number;
      /** `spec`: at the base commit while spec version `round` awaits approval. */
      phase: 'spec' | 'baseline' | 'verify';
      round: number;
      sha: string;
      results: CheckResult[];
    }
  | { type: 'guard.recorded'; specVersion: number; round: number; fromSha: string; sha: string; guard: GuardResult }
  | {
      type: 'review.recorded';
      specVersion: number;
      round: number;
      sha: string;
      report: ReviewReport | null;
      blocking: Finding[];
      downgraded: Finding[];
      error: string | null;
    }
  | {
      type: 'round.decided';
      specVersion: number;
      sha: string;
      round: number;
      decision: 'repair' | 'escalate' | 'ready';
      reasons: string[];
    }
  /** The polish pass's commit, guarded and checked against the ready round's commit `fromSha`. */
  | {
      type: 'polish.checked';
      specVersion: number;
      round: number;
      fromSha: string;
      sha: string;
      guard: GuardResult;
      /** Empty when the guard already discarded the pass. */
      results: CheckResult[];
    }
  /**
   * Whether the polish pass of a ready round was kept. A discarded pass is recorded before the
   * worktree is reset to `fromSha`, so a restarted driver finishes the reset.
   */
  | {
      type: 'polish.decided';
      specVersion: number;
      round: number;
      fromSha: string;
      /** The polished commit; equals `fromSha` when the worker committed nothing. */
      sha: string;
      kept: boolean;
      outcome: 'kept' | 'noop' | 'discarded';
      report: PolishReport | null;
      maintenance: MaintenanceAssessment | null;
      /** Why the pass was discarded; empty when kept. */
      reasons: string[];
      /** The review of the pass's own diff; null when the recipe has no review or it was not reached. */
      review: ReviewResult | null;
      /** The change since the baseline commit before and after the pass. */
      before: DiffSize;
      after: DiffSize;
    }
  | { type: 'polish.restored'; round: number; sha: string }
  | { type: 'attention.needed'; reason: string; detail: string; options: CommandKind[] }
  /** A request that lapsed before the user answered it, such as a quiet worker that reported after all. */
  | { type: 'attention.withdrawn'; reason: string; why: string }
  | { type: 'workers.released'; released: string[]; failures: string[] }
  | { type: 'usage.recorded'; measurements: DispatchMeasurement[] }
  | {
      type: 'explanation.recorded';
      commandId: string;
      baseSha: string;
      candidateSha: string;
      specVersion: number;
      explanation: Explanation | null;
      error: string | null;
    }
  | {
      type: 'answer.recorded';
      commandId: string;
      baseSha: string;
      candidateSha: string;
      specVersion: number;
      question: string;
      groupId: string | null;
      reference: CodeReference | null;
      answer: ExplanationAnswer | null;
      error: string | null;
    }
  | {
      type: 'task.finished';
      outcome: TaskOutcome;
      sha: string | null;
      override: boolean;
      reason: string | null;
    }
  | { type: 'driver.stopped'; reason: string }
  /** The user merged the accepted, verified commit into the repository's checked-out branch. */
  | { type: 'task.merged'; branch: string; sha: string };

/** An event as stored, with its time. */
export type StoredEvent = TaskEvent & { at: string };

const text = (max: number) => z.string().min(1).max(max);

/** A user decision, queued by the CLI, chat or dashboard and applied by the task's driver. */
export const userCommandSchema = z.intersection(
  z.object({
    id: z.uuid(),
    at: z.string(),
    /** Where the command came from; a chat agent acting for the user is recorded as `chat`. */
    source: z.enum(['cli', 'chat', 'dashboard']),
    /** Explicit attribution for an intervention; omitted means the cause is not known. */
    purpose: z.enum(['implementation', 'workflow']).optional(),
  }),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('approve'), specVersion: z.number().int().positive() }),
    z.object({ kind: z.literal('revise'), feedback: text(inputLimits.feedbackLength) }),
    z.object({ kind: z.literal('reply'), messageId: text(200), body: text(inputLimits.feedbackLength) }),
    z.object({ kind: z.literal('continue'), guidance: text(inputLimits.feedbackLength) }),
    z.object({
      kind: z.literal('explain'),
      baseSha: z.string().length(40),
      candidateSha: z.string().length(40),
      specVersion: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('ask'),
      baseSha: z.string().length(40),
      candidateSha: z.string().length(40),
      specVersion: z.number().int().positive(),
      question: text(inputLimits.feedbackLength),
      groupId: z.string().nullable(),
      reference: codeReferenceSchema.nullable(),
    }),
    z.object({ kind: z.literal('retry') }),
    z.object({ kind: z.literal('accept') }),
    z.object({ kind: z.literal('abandon'), reason: z.string().max(inputLimits.feedbackLength).optional() }),
    /** A comparison picked another entry: end this one as not selected, keeping its evidence. */
    z.object({ kind: z.literal('decline') }),
  ]),
);
export type UserCommand = z.infer<typeof userCommandSchema>;
export type CommandKind = UserCommand['kind'];
