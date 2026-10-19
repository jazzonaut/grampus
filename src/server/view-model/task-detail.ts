// Owns the task page DTO (`TaskDetailV1`) and the task facts the overview shares: what the journal says
// about one guided task, gathered once, then turned into the header, workflow strip, current activity,
// decisions, results, usage and on-demand details. Nothing here writes to the journal.
import { z } from 'zod';
import { serverLimits } from '../../config/limits.js';
import type { Evidence } from '../../domain/workflow.js';
import { selectedLenses } from '../../domain/quality-passes.js';
import { guidedTaskView } from '../../orchestration/guided-status.js';
import { guidedDecisionKey } from '../../orchestration/guided/keys.js';
import { rerunChecksIneligibility } from '../../orchestration/guided/rerun.js';
import { guidedSnapshot } from '../../orchestration/guided/snapshots.js';
import type { JournalEvent, Store } from '../../persistence/store.js';
import type { RepositoryCheck } from '../../persistence/records.js';
import { checkIssue, outputExcerpt } from '../../verification/check-output.js';
import type {
  ActivityV1,
  CheckView,
  CommitView,
  CriterionView,
  DetailsV1,
  NextStepV1,
  ResultsV1,
  ScopeView,
  StageState,
  TaskDetailV1,
} from '../api-types.js';
import { action, resolvingActionIds, taskActions, type TaskActionFacts } from './actions.js';
import { poolFullReason, stallView, type ViewContext } from './context.js';
import { planView } from './plan.js';
import { pendingScopeFiles } from './scope.js';
import {
  folderName,
  humanNote,
  providerLabel,
  stageActivity,
  taskPresentation,
  type TaskPresentation,
} from './status.js';
import { currentSettings } from '../../config/settings.js';
import { recentTimeline } from './timeline.js';
import { repairsView } from './repairs.js';
import { guidanceView } from './guidance.js';
import { spendingView } from './spending.js';
import { usageView } from './usage.js';
import { evidenceSource, workflowStages } from './workflow.js';

/** The controller's task view (`guidedTaskView`). */
export type GuidedTaskView = ReturnType<typeof guidedTaskView>;

/** Everything the view model reads about one task from the journal. */
export interface TaskFacts {
  view: GuidedTaskView;
  events: JournalEvent[];
  /** Checks of the current version and slice, across attempts, oldest first. */
  checks: RepositoryCheck[];
  /** Implementation attempts after the first in this slice. */
  repairs: number;
  /** Why the stopped check cannot be rerun, or null when it can. */
  rerunProblem: string | null;
  scope: { files: { path: string; content: string | null }[]; error: string | null };
  instructions: { path: string; content: string }[];
  /** Verified deliveries of this task, oldest first. */
  deliveries: { commit: string | null; outcome: 'committed' | 'no_change'; at: string }[];
}

const deliveredEvent = z.object({
  commit: z.string().nullable(),
  outcome: z.enum(['committed', 'no_change']).nullable(),
});
const failureEvent = z.object({ action: z.string(), note: z.string() });

/** Reads the task's facts from the journal; cached by journal revision by the caller. */
export function taskFacts(store: Store, id: string): TaskFacts {
  const view = guidedTaskView(store, id);
  const { state } = view;
  const snapshot = guidedSnapshot(store, state);
  const executions = store
    .executions()
    .filter(
      execution =>
        execution.taskId === id && execution.version === state.version && execution.sliceIndex === state.sliceIndex,
    );
  const events = store.events(id);
  return {
    view,
    events,
    checks: executions.flatMap(execution => store.checks(execution.id)),
    repairs: executions.filter(execution => execution.stage === 'repair').length,
    rerunProblem: view.stale ? 'The plan is stale' : rerunChecksIneligibility(store, view.task),
    scope: pendingScopeFiles(state, view.workspace?.path ?? null, snapshot),
    instructions: state.status === 'awaiting_scope' ? (snapshot?.instructions ?? []) : [],
    deliveries: events.flatMap(event => {
      if (event.type !== 'delivery.settled') return [];
      const data = deliveredEvent.safeParse(event.data).data;
      return data?.outcome ? [{ commit: data.commit, outcome: data.outcome, at: event.at }] : [];
    }),
  };
}

/** The facts the action rules need, from the task facts and the dashboard's workers. */
export function taskActionFacts(facts: TaskFacts, context: ViewContext): TaskActionFacts {
  const { view } = facts,
    { state } = view;
  const job = context.job(view.task.id);
  return {
    taskId: view.task.id,
    expected: guidedDecisionKey(state, view.questionKey),
    status: state.status,
    stage: state.stage,
    stopCode: state.stopReason?.code ?? null,
    stale: view.stale,
    owner: state.owner !== null,
    pending: state.pending !== null,
    stopRequested: state.stopRequested || view.session?.phase === 'stop_requested',
    pauseRequested: state.pauseRequested,
    jobRunning: job?.running ?? false,
    version: state.version,
    digest: state.digest,
    automatic: state.plan.workflowPolicy.mode === 'automatic',
    rerunProblem: facts.rerunProblem,
    releasable:
      state.stage === 'workspace' &&
      !state.workspaceId &&
      view.workspace?.adapter === 'git' &&
      view.workspace.phase === 'recovery_required',
    scopeError: facts.scope.error,
    poolFull: poolFullReason(context.pool, state.owner !== null),
    questions: view.questions,
    lenses: selectedLenses(state.plan.quality),
    plan: state.plan,
    availablePasses: context.qualityPasses,
  };
}

/** The task's presentation status. */
export function presentTask(facts: TaskFacts, context: ViewContext): TaskPresentation {
  return taskPresentation(taskActionFacts(facts, context));
}

/** The workflow strip of the current slice. */
export function taskWorkflow(facts: TaskFacts, presentation: TaskPresentation) {
  const { task, state } = facts.view;
  return workflowStages({
    plan: state.plan,
    stage: state.stage,
    status: presentation.status,
    version: state.version,
    approved: task.approvedVersion === state.version && state.approvedDigest === state.digest,
    sliceIndex: state.sliceIndex,
    qualityEdits: state.qualityEdits,
    evidence: currentEvidence(facts),
    lenses: facts.view.lenses,
    repairs: facts.repairs,
  });
}

function currentEvidence(facts: TaskFacts): Evidence[] {
  return facts.view.task.evidence.filter(item => !item.id.endsWith(':requested'));
}

/** The note in UI language. A long failure note is replaced by the failing check's compact summary. */
function headerNote(facts: TaskFacts): string | null {
  const note = facts.view.state.note;
  const failed = facts.checks.findLast(check => check.phase === 'failed');
  const text =
    note.length > serverLimits.stateNoteSummaryThreshold && failed
      ? `Check ${failed.spec.name} failed.\n${checkIssue(failed)}`
      : outputExcerpt(note, serverLimits.stateNoteCharacters);
  const human = humanNote(text).trim();
  return human || null;
}

/** The latest failed dashboard action that nothing has superseded since. */
function actionError(facts: TaskFacts, context: ViewContext): TaskDetailV1['header']['actionError'] {
  const job = context.job(facts.view.task.id);
  if (job?.running) return null;
  if (job?.error) return { action: job.action, message: humanNote(job.error), at: job.settledAt };
  const last = facts.events.findLast(
    event => event.type.startsWith('guided.') || event.type === 'dashboard.action_failed',
  );
  if (last?.type !== 'dashboard.action_failed') return null;
  const data = failureEvent.safeParse(last.data).data;
  return data ? { action: data.action, message: humanNote(data.note), at: last.at } : null;
}

function actorOf(facts: TaskFacts, check: RepositoryCheck | undefined): ActivityV1['actor'] {
  const { state } = facts.view;
  if (check) return 'check';
  if (state.stage === 'review') return state.reviewCycle.arbitrating ? 'arbitrator' : 'reviewer';
  return state.stage === 'implementation' || state.stage === 'quality_pass' ? 'implementer' : 'controller';
}

/** Live agent counters, or nulls when no agent turn is reporting progress. */
function progressCounts(progress: GuidedTaskView['progress']) {
  return {
    repositoryCalls: progress?.repositoryCalls ?? null,
    integrationCalls: progress?.integrationCalls ?? null,
    fileRequests: progress?.fileRequests ?? null,
    recent: progress?.recent.map(item => item.label) ?? [],
  };
}

function agentProvider(actor: ActivityV1['actor'], session: GuidedTaskView['session']): ActivityV1['provider'] {
  if (!session || actor === 'check' || actor === 'controller') return null;
  return { id: session.provider, label: providerLabel(session.provider), model: session.model };
}

function activity(facts: TaskFacts, context: ViewContext, presentation: TaskPresentation): ActivityV1 | null {
  if (presentation.status !== 'working' && presentation.status !== 'stopping') return null;
  const { state, progress, session } = facts.view;
  const stopping = presentation.status === 'stopping';
  const described = stageActivity(state.stage, {
    repairing: !!state.failedCheckId && state.repairCycle.used > 0,
    reviewRepairs: state.reviewCycle.repairs,
    arbitrating: state.reviewCycle.arbitrating,
  });
  const check = facts.checks.find(item => item.phase === 'running');
  const since = context.job(facts.view.task.id)?.startedAt ?? null;
  const current = since ? facts.events.filter(event => event.at >= since) : facts.events;
  const actor = actorOf(facts, check);
  const running = check ? `Running ${check.spec.name}` : described.description;
  return {
    title: stopping ? 'Stopping the task' : described.title,
    description: stopping ? 'Waiting for the current operation to stop safely.' : (progress?.activity ?? running),
    actor,
    provider: agentProvider(actor, session),
    stageLabel: described.title,
    startedAt: progress?.startedAt ?? current.findLast(event => event.type === 'guided.step_requested')?.at ?? since,
    lastActivityAt: progress?.lastActivityAt ?? current.at(-1)?.at ?? null,
    ...progressCounts(progress),
  };
}

function nextStep(facts: TaskActionFacts, presentation: TaskPresentation, title: string): NextStepV1 {
  if (presentation.status === 'working' && facts.pauseRequested)
    return {
      kind: 'automatic',
      label: 'The current operation finishes, then Grampus pauses before starting anything else.',
    };
  if (presentation.status === 'working')
    return { kind: 'automatic', label: `${title}; Grampus continues automatically.` };
  if (presentation.status === 'stopping')
    return { kind: 'automatic', label: 'Waiting for the current operation to stop safely.' };
  if (presentation.status === 'complete') return { kind: 'none', label: 'Delivered locally. Nothing else is needed.' };
  if (facts.stale) return { kind: 'human', label: 'Create a new task with the updated requirements.', actionIds: [] };
  const labels: Partial<Record<NonNullable<TaskPresentation['attention']>, string>> = {
    approval: 'Review the plan and approve it.',
    scope_authorization: 'Inspect the files and authorize them.',
    assessment: 'Assess the change against each quality lens.',
    question: 'Answer the questions.',
    recovery: 'Recover saved work.',
  };
  const label =
    presentation.status === 'idle'
      ? 'Continue the task.'
      : ((presentation.attention && labels[presentation.attention]) ??
        `${presentation.label}: choose how to continue.`);
  return { kind: 'human', label, actionIds: resolvingActionIds(facts) };
}

function checkView(taskId: string, check: RepositoryCheck): CheckView {
  const state: StageState =
    check.phase === 'passed'
      ? 'passed'
      : check.phase === 'failed'
        ? 'failed'
        : check.phase === 'running'
          ? 'active'
          : 'unknown';
  const stateLabels: Record<RepositoryCheck['phase'], string> = {
    running: 'Running',
    passed: 'Passed',
    failed: 'Failed',
    interrupted: 'Interrupted',
    recovery_required: 'Needs recovery',
  };
  const purposeLabels: Record<RepositoryCheck['purpose'], string> = {
    preparation: 'Preparation',
    validation: 'Validation',
    verification: 'Acceptance',
  };
  return {
    id: check.id,
    name: check.spec.name,
    purposeLabel: purposeLabels[check.purpose],
    state,
    stateLabel: stateLabels[check.phase],
    evidence: check.phase === 'passed' || check.phase === 'failed' ? 'controller-verified' : null,
    issue: check.phase === 'failed' ? humanNote(checkIssue(check)) : null,
    error: check.error ? humanNote(check.error) : null,
    exitCode: check.result?.exitCode ?? null,
    reason: check.result?.reason ?? null,
    command: { file: check.spec.file, args: [...check.spec.args] },
    timeoutMs: check.spec.timeoutMs,
    stdoutCharacters: check.result ? check.result.stdout.length : null,
    stderrCharacters: check.result ? check.result.stderr.length : null,
    outputTruncated: check.result?.outputTruncated ?? false,
    outputUnavailable: check.result?.outputUnavailable ?? false,
    outputPath: `/api/tasks/${taskId}/check-output?checkId=${encodeURIComponent(check.id)}`,
  };
}

function criteria(facts: TaskFacts): CriterionView[] {
  const { task, state } = facts.view;
  const verification = currentEvidence(facts).findLast(item => item.kind === 'verification');
  const delivered = new Set(
    (task.slice?.completed ?? []).flatMap(item => task.brief.slices?.[item.index]?.criteria ?? []),
  );
  return task.brief.criteria.map((text): CriterionView => {
    if (state.status === 'complete' || delivered.has(text))
      return { text, state: 'passed', evidence: 'controller-verified' };
    if (verification?.criteria?.includes(text))
      return {
        text,
        state: verification.outcome === 'passed' ? 'passed' : verification.outcome === 'failed' ? 'failed' : 'unknown',
        evidence: evidenceSource(verification),
      };
    return { text, state: 'pending', evidence: null };
  });
}

function lenses(facts: TaskFacts): ResultsV1['lenses'] {
  const evidence = currentEvidence(facts);
  return selectedLenses(facts.view.state.plan.quality).map(lens => {
    const verdict = facts.view.lenses.find(item => item.lens === lens.id);
    const recorded = evidence.findLast(item => item.kind === 'quality' && item.pass === lens.id);
    return {
      id: lens.id,
      title: lens.title,
      verdict: verdict?.verdict ?? null,
      summary: verdict?.summary ?? null,
      findings: verdict?.findings.map(finding => ({ ...finding })) ?? [],
      recorded: recorded ? { outcome: recorded.outcome, evidence: evidenceSource(recorded) } : null,
    };
  });
}

function unresolved(facts: TaskFacts, results: Omit<ResultsV1, 'unresolved'>): string[] {
  if (facts.view.state.status === 'complete') return [];
  const blocking = results.findings.filter(finding => finding.severity === 'blocking').length;
  const failedCheck = facts.view.state.failedCheckId
    ? results.checks.find(check => check.id === facts.view.state.failedCheckId)
    : null;
  return [
    ...(blocking ? [`${blocking} blocking review ${blocking === 1 ? 'finding' : 'findings'} to address.`] : []),
    ...results.lenses
      .filter(lens => lens.verdict === 'fail' || lens.recorded?.outcome === 'failed')
      .map(lens => `The ${lens.title} lens did not pass.`),
    ...(failedCheck
      ? [`${failedCheck.purposeLabel} ${failedCheck.name}: ${failedCheck.stateLabel.toLowerCase()}.`]
      : []),
    ...(facts.scope.error ? [`File authorization could not be prepared: ${facts.scope.error}`] : []),
  ];
}

function results(facts: TaskFacts): ResultsV1 {
  const { view } = facts;
  const commits: CommitView[] = facts.deliveries.map((delivery, index) => ({
    slice: index + 1,
    commit: delivery.commit,
    outcome: delivery.outcome,
  }));
  const partial = {
    criteria: criteria(facts),
    checks: facts.checks.map(check => checkView(view.task.id, check)),
    findingsTitle: view.carriedFindings ? 'Earlier review findings to address' : 'Independent review findings',
    findings: view.findings.map(finding => ({ ...finding })),
    lenses: lenses(facts),
    qualityEdits: view.state.qualityEdits.map(edit => ({
      id: edit.pass,
      title: view.state.plan.quality.passes.find(pass => pass.id === edit.pass)?.title ?? edit.pass,
      changed: edit.before !== edit.after,
    })),
    commits,
  };
  return { ...partial, unresolved: unresolved(facts, partial) };
}

function scopeView(facts: TaskFacts): ScopeView | null {
  const { state } = facts.view;
  if (state.status !== 'awaiting_scope') return null;
  const slice = state.plan.slices[state.sliceIndex];
  const created = new Set(state.policy?.create ?? slice?.scope.create ?? []);
  const deleted = new Set(state.policy?.delete ?? slice?.scope.delete ?? []);
  return {
    files: facts.scope.files.map(file => ({
      ...file,
      action: deleted.has(file.path) ? 'delete' : created.has(file.path) ? 'create' : 'edit',
    })),
    instructions: facts.instructions.map(item => ({ path: item.path, content: item.content })),
    error: facts.scope.error,
  };
}

function details(facts: TaskFacts): DetailsV1 {
  const { view } = facts,
    { state, task } = view;
  const id = task.id;
  return {
    approval: { version: state.version, digest: state.digest, approved: state.approvedDigest === state.digest },
    artifact: {
      artifact: state.snapshot?.artifact ?? null,
      instructionsDigest: state.snapshot?.instructionsDigest ?? null,
      head: state.snapshot?.head ?? null,
    },
    changes: [...(state.snapshot?.changedPaths ?? [])],
    changesPath: `/api/v1/tasks/${id}/changes`,
    plan: planView(state.plan),
    scope: scopeView(facts),
    references: (state.plan.references ?? []).map((reference, index) => ({
      label: `reference-${index + 1}`,
      path: reference.path,
      files: reference.totalFiles,
      base: reference.base,
    })),
    workspace: {
      path: view.workspace?.path ?? state.plan.workspace.path ?? null,
      adapter: state.plan.workspace.adapter,
    },
    exploration: { calls: view.exploration.calls, readFiles: [...view.exploration.readFiles] },
    timeline: {
      total: facts.events.length,
      recent: recentTimeline(facts.events),
      path: `/api/v1/tasks/${id}/timeline`,
    },
    reportPath: `/api/tasks/${id}/report`,
  };
}

/** Navigation is available only for an adopted Orca workspace and a configured desktop adapter. */
function orcaView(facts: TaskFacts, context: ViewContext): TaskDetailV1['orca'] {
  const { task, workspace } = facts.view;
  if (!context.orca || workspace?.adapter !== 'orca' || workspace.phase !== 'ready' || !workspace.orca?.identityKey)
    return null;
  return {
    open: action({
      id: 'open-orca',
      label: 'Open workspace in Orca',
      kind: 'secondary',
      description: 'Open this task in its Orca workspace. Grampus continues to control the task.',
      path: `/api/tasks/${task.id}/open-orca`,
    }),
    problem: context.orca(task.id)?.problem ?? null,
  };
}

/** `GET /api/v1/tasks/:id`. */
export function taskDetail(facts: TaskFacts, context: ViewContext, revision: string): TaskDetailV1 {
  const { view } = facts,
    { state, task } = view;
  const actionFacts = taskActionFacts(facts, context);
  const presentation = taskPresentation(actionFacts);
  const current = activity(facts, context, presentation);
  const sliceBrief = task.brief.slices?.[state.sliceIndex];
  return {
    apiVersion: 1,
    revision,
    id: task.id,
    orca: orcaView(facts, context),
    header: {
      title: task.brief.title,
      outcome: task.brief.outcome,
      repository: { name: folderName(state.plan.workspace.repo), path: state.plan.workspace.repo },
      slice: {
        index: state.sliceIndex + 1,
        count: state.plan.slices.length,
        title: sliceBrief?.title ?? task.brief.title,
      },
      status: presentation.status,
      statusLabel: presentation.label,
      explanation: presentation.explanation,
      note: headerNote(facts),
      stopReason: state.stopReason ? { code: state.stopReason.code, at: state.stopReason.at } : null,
      nextStep: nextStep(actionFacts, presentation, current?.title ?? presentation.label),
      stalled: stallView(context.stall(task.id)),
      actionError: actionError(facts, context),
      mode: state.plan.workflowPolicy.mode,
      stale: view.stale,
    },
    workflow: taskWorkflow(facts, presentation),
    activity: current,
    liveChangesPath:
      view.workspace?.phase === 'ready' && view.workspace.path ? `/api/v1/tasks/${task.id}/live-changes` : null,
    repairs: repairsView(facts.events, state),
    spending: spendingView(view.usage, state.plan.workflowPolicy),
    guidance: guidanceView(
      task.id,
      state,
      facts.events,
      actionFacts.expected,
      !view.stale && state.approvedDigest === state.digest && task.approvedVersion === state.version,
      actionFacts.jobRunning && !actionFacts.owner,
    ),
    liveChangesIntervalMs: currentSettings().liveChangesIntervalMs,
    decisions: taskActions(actionFacts),
    results: results(facts),
    usage: usageView(view.usage),
    details: details(facts),
    integrations: view.integrations
      .filter(server => server.status === 'connected')
      .map(server => ({ name: server.name, status: server.status, tools: server.tools ?? null })),
  };
}
