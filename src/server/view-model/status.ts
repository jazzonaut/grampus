// Owns the dashboard's status language: internal guided status, stage and stop reason in, the fixed
// presentation vocabulary, a label and a one-sentence explanation out. The per-stop table below is the
// single place that says why a task stopped in human terms; notes are rewritten into UI language here.
import type { Stage, Status } from '../../orchestration/guided/state.js';
import type { StopReasonCode } from '../../orchestration/guided/stop-reasons.js';
import { plainOutput } from '../../verification/check-output.js';
import type { AttentionKind, PresentationStatus, ProviderId } from '../api-types.js';

/** How a stop is presented: its attention kind, presentation status, label and one-sentence reason. */
export interface StopPresentation {
  kind: AttentionKind;
  status: Extract<PresentationStatus, 'awaiting_human' | 'failed' | 'blocked'>;
  label: string;
  why: string;
}

const wait = (kind: AttentionKind, label: string, why: string): StopPresentation => ({
  kind,
  status: 'awaiting_human',
  label,
  why,
});
const failure = (kind: AttentionKind, label: string, why: string): StopPresentation => ({
  kind,
  status: 'failed',
  label,
  why,
});
const blocked = (kind: AttentionKind, label: string, why: string): StopPresentation => ({
  kind,
  status: 'blocked',
  label,
  why,
});
const recovery = (label: string, why: string) => blocked('recovery', label, why);

/** Every stop reason code in UI language. Exhaustive: a new code fails to compile until it is described. */
export const stopPresentation: Readonly<Record<StopReasonCode, StopPresentation>> = {
  DIAGNOSTIC_ALLOWANCE_REQUIRED: wait(
    'approval',
    'Diagnostic allowance needed',
    'Approve the displayed additional attempts or revise the plan. Ordinary answers do not change permissions.',
  ),
  CHECK_ENVIRONMENT_FAILED: blocked(
    'failed_check',
    'Browser environment failed',
    'Inspect the retained browser lifecycle failure before explicitly rerunning checks. No implementation repair was spent.',
  ),
  TASK_TURN_LIMIT: wait(
    'blocked',
    'Task turn allowance exhausted',
    'Revise the approved task-wide allowance before another agent turn.',
  ),
  TASK_TOKEN_LIMIT: wait(
    'blocked',
    'Task token threshold reached',
    'Revise the approved task-wide threshold before another agent turn.',
  ),
  TASK_USAGE_UNKNOWN: wait(
    'blocked',
    'Task token usage unknown',
    'Inspect incomplete usage, then revise and approve the token policy before another agent turn.',
  ),
  GUIDANCE_PENDING: wait(
    'blocked',
    'Guidance needs a decision',
    'No agent turn is scheduled before delivery. Cancel the queued guidance to continue, or revise the plan if it must be acted on.',
  ),
  USER_PAUSED: wait(
    'blocked',
    'Paused',
    'The current operation finished. Continue the task to resume its saved attempt; files and evidence are kept.',
  ),
  APPROVAL_REQUIRED: wait(
    'approval',
    'Plan ready for approval',
    'The plan waits for your approval of this exact version before any work starts.',
  ),
  SCOPE_AUTHORIZATION_REQUIRED: wait(
    'scope_authorization',
    'Workspace confirmation needed',
    'Supervised mode: inspect the workspace and confirm native execution within the approved requirements.',
  ),
  ASSESSMENT_REQUIRED: wait(
    'assessment',
    'Quality assessment needed',
    'Supervised mode: assess the change against each selected quality lens before review continues.',
  ),
  ASSESSMENT_UNSETTLED: wait(
    'assessment',
    'Quality assessment needed',
    'The assessment step settled without an accepted assessment, so it is needed again.',
  ),
  AGENT_QUESTION: wait(
    'question',
    'Your answer is needed',
    'The agent asked questions that could change the result; answer them to continue.',
  ),
  PREPARATION_FAILED: failure(
    'failed_check',
    'Preparation failed',
    'The approved preparation command did not pass; resolve the cause, then retry preparation.',
  ),
  PREPARATION_INTERRUPTED: blocked(
    'blocked',
    'Preparation interrupted',
    'The preparation command was interrupted, usually by a stop request.',
  ),
  IMPLEMENTATION_FAILED: failure(
    'blocked',
    'Implementation failed',
    'The implementation turn failed or returned no settled change.',
  ),
  IMPLEMENTATION_INTERRUPTED: blocked(
    'blocked',
    'Implementation stopped',
    'The implementation turn was interrupted, usually by a stop request.',
  ),
  PROMPT_BUDGET_EXCEEDED: failure(
    'blocked',
    'Prompt too large',
    'The context this turn must carry does not fit the prompt budget, so nothing was sent to the agent. Enable repository exploration or revise the task into smaller slices.',
  ),
  QUALITY_PASS_FAILED: failure(
    'blocked',
    'Quality pass failed',
    'An edit quality pass failed or returned no settled change; a retry runs it again after implementing.',
  ),
  CHECKPOINT_CHANGED: blocked(
    'blocked',
    'Files were staged during the run',
    'Files were staged or unstaged during the implementation; finish staging, then retry repair.',
  ),
  REPAIR_WORKSPACE_CHANGED: blocked(
    'blocked',
    'Workspace changed',
    'The workspace changed between automatic repair attempts; inspect it, then retry.',
  ),
  REVISION_WORKSPACE_CHANGED: blocked(
    'blocked',
    'Workspace changed',
    'The retained workspace changed after the revised plan was approved.',
  ),
  SCOPE_REJECTED: failure(
    'blocked',
    'File scope rejected',
    "The approved file scope is not valid for the current workspace; revise this task's plan if it is unsupported.",
  ),
  CHECK_FAILED_SUPERVISED: failure(
    'failed_check',
    'Check failed',
    'Supervised mode: a failed check waits for you to retry the repair.',
  ),
  CHECK_FAILED_NO_CHANGE: failure(
    'failed_check',
    'Check failed',
    'A no-change slice failed its check, so there is nothing an implementer may repair.',
  ),
  CHECK_INTERRUPTED: blocked(
    'blocked',
    'Check interrupted',
    'The check was interrupted rather than failing on its own.',
  ),
  CHECK_TIMEOUT: blocked(
    'blocked',
    'Check timed out',
    'The check exceeded its approved time limit, which says nothing about the change itself.',
  ),
  CHECK_OUTPUT_LIMIT: blocked(
    'resource_limit',
    'Check output limit reached',
    'The check printed more than the output limit; revise the check, because a rerun prints the same.',
  ),
  CHECK_EXIT_UNCONFIRMED: blocked(
    'blocked',
    'Check exit unconfirmed',
    'The check did not exit normally with a confirmed process exit.',
  ),
  CHECK_OUTPUT_UNAVAILABLE: blocked(
    'blocked',
    'Check output unavailable',
    "The check's output could not be read, so its result cannot be diagnosed.",
  ),
  CHECK_OUTPUT_TRUNCATED: blocked(
    'resource_limit',
    'Check output truncated',
    'An acceptance comparison ran on truncated output, so the evidence is incomplete.',
  ),
  CHECK_ERROR: blocked(
    'blocked',
    'Check runner error',
    'The check runner recorded an error other than a failed expectation.',
  ),
  CHECK_MUTATED_ARTIFACT: failure(
    'failed_check',
    'Check changed files',
    'The check changed repository inputs while it ran, so its result cannot count as evidence.',
  ),
  CHECK_STALE_ARTIFACT: blocked(
    'blocked',
    'Check ran on other files',
    'The check ran against a different change from the one Grampus holds.',
  ),
  CHECK_NO_PROGRESS: failure(
    'failed_check',
    'Repair made no progress',
    'An automatic repair left the failing change unchanged, so Grampus stopped spending turns on it.',
  ),
  CHECK_REPAIR_EXHAUSTED: failure(
    'failed_check',
    'Repair allowance used up',
    "The check still fails and this slice's shared repair allowance is used up.",
  ),
  READINESS_REPAIR_EXHAUSTED: failure(
    'failed_check',
    'Readiness allowance used up',
    'A mechanical check still fails and this slice has no automatic readiness repairs left. Behavioural repairs have a separate allowance.',
  ),
  READINESS_NO_PROGRESS: failure(
    'failed_check',
    'Readiness repair made no progress',
    'The same mechanical check failed on unchanged content after a readiness repair.',
  ),
  QUALITY_ASSESSMENT_FAILED: failure(
    'review_findings',
    'Quality assessment failed',
    'A recorded quality lens assessment did not pass.',
  ),
  REVIEW_BLOCKING_FINDINGS: failure(
    'review_findings',
    'Review found blocking issues',
    'The independent review recorded blocking findings.',
  ),
  REVIEW_REPAIR_EXHAUSTED: failure(
    'review_findings',
    'Shared repair allowance used up',
    'Blocking review findings remain and the shared slice repair allowance is used up.',
  ),
  REVIEW_NO_PROGRESS: failure(
    'review_findings',
    'Review made no progress',
    'The artifact is unchanged or an earlier blocking finding remains unresolved.',
  ),
  REVIEW_PROGRESS_UNCONFIRMED: failure(
    'review_findings',
    'Review progress needs evidence',
    'The reviewer did not account for every earlier blocker with a unique evidenced disposition.',
  ),
  ARBITRATION_UNRESOLVED: failure(
    'review_findings',
    'Arbitration kept a blocking finding',
    'The fresh arbitrator kept a blocking finding, so the change needs your decision.',
  ),
  REVIEW_FAILED_NO_BLOCKING_FINDINGS: failure(
    'review_findings',
    'Review did not pass',
    'The review did not pass but named no blocking finding to repair.',
  ),
  REVIEW_TURN_FAILED: blocked('blocked', 'Review turn failed', 'The review turn itself failed or was interrupted.'),
  REVIEW_MISSING_LENS: failure(
    'review_findings',
    'Review missed a quality lens',
    'A passing review did not assess every selected quality lens.',
  ),
  REVIEW_HISTORY_LIMIT: blocked(
    'resource_limit',
    'Review history limit reached',
    "This slice's review history is too long to resend to the reviewer in full.",
  ),
  DELIVERY_FAILED: failure(
    'blocked',
    'Delivery failed',
    'Local delivery settled without a verified commit; the index, files and any commit are kept for inspection.',
  ),
  RESULT_MISSING: recovery('Result missing', 'A step returned without a durable result.'),
  RESULT_AMBIGUOUS: recovery('Result ambiguous', 'More than one new result matches the step, so none can be adopted.'),
  RESULT_FOREIGN: recovery(
    'Result from another controller',
    "A new result was produced under a different controller's lease.",
  ),
  RESULT_MISMATCH: recovery(
    'Result does not match its request',
    'A result differs from the exact request the step journaled.',
  ),
  OPERATION_NEEDS_RECOVERY: recovery(
    'Operation needs recovery',
    'The operation behind the step is still running or needs explicit recovery.',
  ),
  SUBMISSION_UNSETTLED: recovery('Submission unsettled', 'Submission returned without a settled successful attempt.'),
  SETTLEMENT_UNCONFIRMED: recovery(
    'Settlement unconfirmed',
    'The controller exited with a pending step or an unsettled workspace.',
  ),
  RECOVERY_BLOCKED: recovery('Recovery blocked', 'Recovery could not prove what happened, so nothing was replayed.'),
  RECOVERY_REQUIRED: recovery(
    'Recovery needed',
    'A step failed after it may have started work; recovery checks the saved evidence without replaying it.',
  ),
  UNEXPECTED_ERROR: blocked('blocked', 'Stopped by an error', 'A step failed before it started any work.'),
};

/** Labels of the guided statuses when no stop reason says more. */
const statusLabels: Readonly<Record<Status, string>> = {
  draft: 'Plan ready for approval',
  ready: 'Ready to continue',
  running: 'Working',
  awaiting_scope: 'Workspace confirmation needed',
  awaiting_assessment: 'Quality assessment needed',
  awaiting_answer: 'Your answer is needed',
  blocked: 'Needs attention',
  recovery_required: 'Recovery needed',
  complete: 'Delivered locally',
};

/** What the controller is doing at each stage: a title and one sentence. */
export function stageActivity(
  stage: Stage,
  context: { repairing: boolean; reviewRepairs: number; arbitrating: boolean },
): { title: string; description: string } {
  const activity = (title: string, description: string) => ({ title, description });
  switch (stage) {
    case 'workspace':
      return activity('Preparing the workspace', 'Creating the worktree and checking its repository baseline.');
    case 'execution':
      return activity('Preparing implementation', 'Capturing repository context for the implementer.');
    case 'preparation':
      return activity('Preparing the workspace', 'Running the approved preparation command before implementation.');
    case 'refresh':
      return activity('Preparing checks', 'Refreshing prerequisites within the approved plan before validation.');
    case 'scope':
      return activity('Inspecting the workspace', 'Capturing the candidate baseline and repository instructions.');
    case 'implementation':
      return activity(
        context.repairing
          ? 'Repairing the check failure'
          : context.reviewRepairs
            ? 'Addressing review findings'
            : 'Implementing the change',
        'The implementer is adapting the approach with native workspace tools.',
      );
    case 'quality_pass':
      return activity(
        'Running a quality pass',
        'The implementer is applying an approved quality pass using native workspace tools.',
      );
    case 'validation':
      return activity('Running validation', 'Running the approved validation command and collecting its result.');
    case 'readiness':
      return activity(
        'Checking implementation readiness',
        'Running the approved formatting, lint or type checks before behavioural validation.',
      );
    case 'submission':
      return activity(
        'Collecting change evidence',
        'Checking the changed files and retaining the implementation result.',
      );
    case 'assessment':
      return activity('Recording quality assessments', 'Saving the assessment of each selected quality lens.');
    case 'review_execution':
      return activity('Preparing independent review', 'Capturing the change and its evidence for the reviewer.');
    case 'review':
      return activity(
        context.arbitrating ? 'Arbitrating review findings' : 'Reviewing the change',
        'The reviewer is inspecting the change and its supporting evidence.',
      );
    case 'verification':
      return activity(
        'Checking acceptance criteria',
        'Running the approved acceptance command and collecting evidence.',
      );
    case 'delivery':
      return activity('Delivering locally', 'Verifying the final change and creating the local commit.');
    case 'complete':
      return activity('Finishing the task', 'Saving the final task result.');
  }
}

/** The facts the task status depends on. */
export interface TaskStatusFacts {
  status: Status;
  stopCode: StopReasonCode | null;
  stale: boolean;
  /** A guided controller owns the runner. */
  owner: boolean;
  /** A fresh identity observation proves the recorded controller is gone or its PID was reused. */
  ownerMissing?: boolean;
  /** A journaled step intent has not settled. */
  pending: boolean;
  stopRequested: boolean;
  /** This dashboard started a worker for the task and it has not exited. */
  jobRunning: boolean;
}

/** A task's presentation status, label and one-sentence explanation. */
export interface TaskPresentation {
  status: PresentationStatus;
  label: string;
  explanation: string;
  /** Present when the task waits for a person or is stopped. */
  attention: AttentionKind | null;
}

/** Whether a controller is (or may still be) working: a worker of this dashboard or a runner owner. */
export function isLive(facts: Pick<TaskStatusFacts, 'jobRunning' | 'owner' | 'ownerMissing'>): boolean {
  return !facts.ownerMissing && (facts.jobRunning || facts.owner);
}

/** Whether the task needs explicit recovery before anything else: an unsettled step or ownership. */
export function needsRecovery(facts: TaskStatusFacts): boolean {
  if (facts.ownerMissing) return true;
  if (facts.jobRunning) return false;
  if (facts.owner) return facts.status !== 'running';
  return facts.pending || facts.status === 'recovery_required';
}

/**
 * Internal status, stop reason and liveness to the presentation vocabulary. A controller that owns a
 * running task but was not started by this dashboard is still working (workers outlive a dashboard
 * restart); ownership on any other status means recovery is needed.
 */
export function taskPresentation(facts: TaskStatusFacts): TaskPresentation {
  if (facts.stale)
    return {
      status: 'unknown',
      label: 'Plan is stale',
      explanation:
        'The approved plan no longer matches the task record. Inspect the journal and create a new task with the updated requirements.',
      attention: 'blocked',
    };
  if (facts.ownerMissing)
    return {
      status: 'blocked',
      label: 'Controller recovery needed',
      explanation:
        'The recorded controller process is no longer running. Recover saved work to reconcile its pending operation; nothing is replayed automatically.',
      attention: 'recovery',
    };
  if (isLive(facts) && facts.stopRequested)
    return {
      status: 'stopping',
      label: 'Stopping',
      explanation: 'A stop was requested; the current operation is settling and nothing new starts.',
      attention: null,
    };
  if (facts.jobRunning || (facts.owner && facts.status === 'running'))
    return {
      status: 'working',
      label: 'Working',
      explanation: facts.jobRunning
        ? 'Grampus is working on the task within the approved scope.'
        : 'A Grampus controller outside this dashboard owns the task and is working on it.',
      attention: null,
    };
  if (needsRecovery(facts)) {
    const stop = facts.stopCode && stopPresentation[facts.stopCode].kind === 'recovery' ? facts.stopCode : null;
    return {
      status: 'blocked',
      label: stop ? stopPresentation[stop].label : statusLabels.recovery_required,
      explanation: stop
        ? stopPresentation[stop].why
        : 'The previous operation needs reconciliation. Recovery checks saved process and result evidence; it does not replay work.',
      attention: 'recovery',
    };
  }
  return settledPresentation(facts);
}

function settledPresentation(facts: TaskStatusFacts): TaskPresentation {
  const stop = facts.stopCode ? stopPresentation[facts.stopCode] : null;
  switch (facts.status) {
    case 'draft':
      return {
        status: 'awaiting_human',
        label: statusLabels.draft,
        explanation: stopPresentation.APPROVAL_REQUIRED.why,
        attention: 'approval',
      };
    case 'ready':
      return {
        status: 'idle',
        label: statusLabels.ready,
        explanation: 'The task is settled; continue it to run to its next decision point.',
        attention: null,
      };
    case 'running':
      return {
        status: 'unknown',
        label: 'State unknown',
        explanation: 'The task is marked running but no controller owns it; recover to reconcile it.',
        attention: 'recovery',
      };
    case 'awaiting_scope':
    case 'awaiting_assessment':
    case 'awaiting_answer':
      return {
        status: 'awaiting_human',
        label: statusLabels[facts.status],
        explanation: stop?.why ?? statusLabels[facts.status],
        attention:
          facts.status === 'awaiting_scope'
            ? 'scope_authorization'
            : facts.status === 'awaiting_answer'
              ? 'question'
              : 'assessment',
      };
    case 'blocked':
    case 'recovery_required':
      return stop
        ? { status: stop.status, label: stop.label, explanation: stop.why, attention: stop.kind }
        : {
            status: 'blocked',
            label: statusLabels.blocked,
            explanation: 'The task stopped without a recorded reason; inspect the note and timeline.',
            attention: 'blocked',
          };
    case 'complete':
      return {
        status: 'complete',
        label: statusLabels.complete,
        explanation: 'Every gate passed on the final change and the verified commit is in your local repository.',
        attention: null,
      };
  }
}

/** A planning conversation's session phase to the presentation vocabulary. */
export function kickoffPresentation(facts: {
  phase: 'idle' | 'running' | 'awaiting_answer' | 'stop_requested' | 'interrupted' | 'failed' | 'recovery_required';
  jobRunning: boolean;
  uncertain: boolean;
  hasProposal: boolean;
  error: string | null;
  converted: boolean;
}): TaskPresentation {
  if (facts.converted)
    return {
      status: 'complete',
      label: 'Task prepared',
      explanation: 'This proposal became a task; continue there.',
      attention: null,
    };
  if (facts.phase === 'stop_requested')
    return {
      status: 'stopping',
      label: 'Stopping',
      explanation: 'Waiting for the planner to stop safely.',
      attention: null,
    };
  if (facts.jobRunning || facts.phase === 'running')
    return {
      status: 'working',
      label: 'Planning',
      explanation: 'The planner is reading the repository and preparing its reply.',
      attention: null,
    };
  if (facts.uncertain)
    return {
      status: 'blocked',
      label: 'Recovery needed',
      explanation: 'The earlier planner still owns its session. Recovery must prove that its processes exited.',
      attention: 'recovery',
    };
  if (facts.phase === 'awaiting_answer')
    return {
      status: 'awaiting_human',
      label: 'Your answer is needed',
      explanation: 'The planner asked questions that could change the plan.',
      attention: 'question',
    };
  if (facts.phase === 'failed' || facts.phase === 'interrupted' || facts.error)
    return {
      status: facts.phase === 'interrupted' ? 'blocked' : 'failed',
      label: facts.phase === 'interrupted' ? 'Planning interrupted' : 'Planning stopped',
      explanation: facts.error
        ? 'The last planning turn did not produce a usable plan; send a message to continue.'
        : 'The last planning turn did not finish; send a message to continue.',
      attention: 'blocked',
    };
  if (facts.hasProposal)
    return {
      status: 'awaiting_human',
      label: 'Plan proposed',
      explanation: 'A proposed plan is ready; review it for approval or ask for changes.',
      attention: 'plan_ready',
    };
  return {
    status: 'idle',
    label: 'Discussing',
    explanation: 'Describe the change or ask the planner to prepare a plan.',
    attention: null,
  };
}

const providerNames: Readonly<Record<ProviderId, string>> = { codex: 'Codex', claude: 'Claude' };

/** "Codex" or "Claude". */
export function providerLabel(provider: ProviderId): string {
  return providerNames[provider];
}

/** CLI command names that controller notes mention, and what the dashboard calls the same thing. */
const commandNames: readonly (readonly [RegExp, string])[] = [
  [/\btask-authorize\b/g, 'the workspace confirmation button'],
  [/\btask-answer\b/g, 'the answer form'],
  [/\btask-assess\b/g, 'the quality assessment form'],
  [/\btask-rerun-checks\b/g, 'Rerun checks'],
  [/\btask-retry\b/g, 'a repair attempt'],
  [/\btask-recover\b/g, 'Recover saved work'],
  [/\btask-run\b/g, 'Continue task'],
  [/\btask-show\b/g, 'the task details'],
];

/** A controller note in dashboard language: control characters removed and CLI command names replaced. */
export function humanNote(text: string): string {
  return commandNames.reduce((note, [pattern, name]) => note.replace(pattern, name), plainOutput(text));
}

/** The last path segment of a folder, for lists. */
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}
