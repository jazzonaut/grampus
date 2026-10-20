// Owns the read-only view of one guided task for the CLI and dashboard: its state, the next action as
// a ready-to-run command, the underlying recovery command, progress, usage and the evidence on
// display. It never changes the task; every command it offers is re-validated when it runs.
import type { Store } from '../persistence/store.js';
import type { Execution, ExecutionLease, Session, Workspace } from '../persistence/records.js';
import { Workflow, type Task } from '../domain/workflow.js';
import { GuidedTasks } from './guided/controller.js';
import { guidedDecisionDigest, guidedQuestionKey } from './guided/keys.js';
import { rerunChecksIneligibility } from './guided/rerun.js';
import type { GuidedState } from './guided/state.js';
import { selectedLenses } from '../domain/quality-passes.js';
import { Sessions } from '../execution/sessions.js';
import { guidedPlanDigest } from '../domain/guided-plan.js';
import { deepEqual } from '../domain/deep-equal.js';
import { explorationSummary } from '../repository/repository-tools.js';
import { integrationSummary } from '../providers/integrations.js';
import { taskUsage, usageLines } from '../reporting/task-usage.js';
import { agentProgress } from './planner-progress.js';
import { guidedSnapshot } from './guided/snapshots.js';
import { isSpendingStop, spendingLines, spendingStatus } from './guided/spending.js';

/** Builds a copy-and-paste CLI command for this journal. */
type Command = (...args: string[]) => string;

/** The next action for a task that is not stale and has no owner, pending step or recovery. */
function statusAction(state: GuidedState, id: string, command: Command, rerun: string | null): string {
  switch (state.status) {
    case 'draft':
      return command('task-approve', id, String(state.version), state.digest);
    case 'awaiting_scope':
      return command('task-authorize', id);
    case 'awaiting_assessment':
      return `${command('task-assess', id)} --outcome '<passed|failed|skipped>' --summary '<your concrete assessment covering ${selectedLenses(
        state.plan.quality,
      )
        .map(lens => lens.id)
        .join(', ')}>'`;
    case 'awaiting_answer':
      return `${command('task-answer', id)} '<answers.json>'`;
    case 'blocked':
      if (isSpendingStop(state.stopReason?.code))
        return `${command('task-revise', id)} ${state.version} '<revised-plan.json>'`;
      if (state.stopReason?.code === 'GUIDANCE_PENDING') return `${command('task-show', id)} --details`;
      if (state.stopReason?.code === 'USER_PAUSED') return command('task-run', id);
      return rerun ?? command('task-retry', id);
    case 'complete':
      return command('report', id);
    case 'recovery_required':
      return command('task-recover', id);
    case 'ready':
    case 'running':
      return command('task-run', id);
  }
}

/**
 * The leaf recovery command for whatever holds the workspace lease, or for unfinished workspace
 * creation. Shown beside the guided recovery because the same evidence requirements apply to both.
 */
function recoveryCommand(lease: ExecutionLease | null, workspace: Workspace | null, command: Command): string | null {
  if (!lease)
    return workspace && !['ready', 'released'].includes(workspace.phase)
      ? command('workspace-recover', workspace.id)
      : null;
  const action =
    lease.kind === 'implementation'
      ? 'implementation-recover'
      : lease.kind === 'delivery'
        ? 'delivery-recover'
        : lease.kind === 'check' || lease.kind === 'verification'
          ? 'check-recover'
          : lease.readOnlyRecovery
            ? 'execution-recover'
            : 'session-recover';
  const target = lease.readOnlyRecovery
    ? lease.executionId
    : lease.kind === 'conversation'
      ? lease.sessionId
      : lease.runId;
  return command(action, target);
}

/** The rerun-checks command for a settled infrastructure stop on the unchanged artifact, else null. */
function rerunCommand(store: Store, task: Task, state: GuidedState, stale: boolean, command: Command): string | null {
  if (stale || state.owner || rerunChecksIneligibility(store, task)) return null;
  return command('task-rerun-checks', task.id, guidedDecisionDigest(state, guidedQuestionKey(store, state)));
}

/** The single next action: inspection when stale, recovery when anything may be live or uncertain. */
function nextAction(state: GuidedState, id: string, stale: boolean, command: Command, rerun: string | null): string {
  if (stale) return command('show', id);
  if (state.owner || state.pending || state.status === 'recovery_required') return command('task-recover', id);
  return statusAction(state, id, command, rerun);
}

/** Whether the task's plan no longer matches its task record, so only inspection is offered. */
function staleState(task: Task, state: GuidedState): boolean {
  return (
    task.version !== state.version ||
    !deepEqual(task.brief, state.plan.brief) ||
    guidedPlanDigest(state.plan) !== state.digest
  );
}

/**
 * The current implementation and review executions, the session on display (the reviewer's during
 * review, otherwise the implementer's) and the events of both sessions for the exploration summary.
 */
function executionsOnDisplay(store: Store, state: GuidedState) {
  const execution = state.executionId ? store.execution(state.executionId) : null;
  const review = state.reviewId ? store.execution(state.reviewId) : null;
  const displayed = state.stage === 'review' && review ? review : execution;
  const session = displayed ? new Sessions(store).get(displayed.sessionId) : null;
  const explorationEvents = [
    ...new Set([execution?.sessionId, review?.sessionId].filter((id): id is string => !!id)),
  ].flatMap(sessionId => store.sessionEvents(sessionId));
  return { execution, review, session, explorationEvents };
}

/** Live progress of the agent turn of an agent stage; null in any other stage. */
function stageProgress(store: Store, state: GuidedState, session: Session) {
  if (state.stage !== 'implementation' && state.stage !== 'quality_pass' && state.stage !== 'review') return null;
  return agentProgress(
    store.sessionEvents(session.id),
    session,
    state.stage === 'review' ? 'review' : 'implementation',
  );
}

/**
 * The review verdict on display: the current review's, or after a repair the latest blocking verdict,
 * which stays on display until a new review has replied. `carried` says which.
 */
function verdictOnDisplay(store: Store, state: GuidedState, review: Execution | null) {
  const sessions = new Sessions(store);
  const current = review ? sessions.get(review.sessionId).lastReply : null;
  const previous = state.reviewCycle.history.at(-1);
  const carried = !current && previous ? sessions.get(store.execution(previous.executionId).sessionId).lastReply : null;
  return { verdict: current ?? carried, carried: !!carried };
}

/** The leaf records of the current implementation execution, oldest first. */
function executionRecords(store: Store, execution: Execution | null) {
  return {
    checks: execution ? store.checks(execution.id) : [],
    implementations: execution ? store.implementations(execution.id) : [],
    deliveries: execution ? store.deliveries(execution.id) : [],
  };
}

/**
 * Everything the CLI and dashboard show for one guided task, read in one transaction so the parts are
 * consistent with each other. `next` is the single next action; `rerun` is offered only for a settled
 * infrastructure stop on the unchanged artifact. Throws when the task has no guided plan.
 */
export function guidedTaskView(store: Store, id: string) {
  return store.transaction(() => {
    const task = new Workflow(store).get(id),
      state = new GuidedTasks(store).get(id);
    const workspace = store.workspaces().find(item => item.taskId === id) ?? null;
    const { execution, review, session, explorationEvents } = executionsOnDisplay(store, state);
    // PowerShell single-quoted literals: nothing inside is expanded and a quote is doubled.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command: Command = (...args) => `npm start -- --db ${quote(store.path)} ${args.map(quote).join(' ')}`;
    const stale = staleState(task, state);
    const rerun = rerunCommand(store, task, state, stale, command);
    const next = nextAction(state, id, stale, command, rerun);
    const lease = workspace ? store.lease(workspace.id) : null;
    const usage = taskUsage(store, id);
    const { verdict, carried } = verdictOnDisplay(store, state, review);
    return {
      task,
      state,
      stale,
      workspace,
      lease,
      session,
      progress: session ? stageProgress(store, state, session) : null,
      next,
      rerun,
      recovery: recoveryCommand(lease, workspace, command),
      usage,
      usageSummary: usageLines(usage),
      carriedFindings: carried,
      integrations: integrationSummary(session ? store.sessionEvents(session.id) : []),
      exploration: explorationSummary(explorationEvents),
      questionKey: guidedQuestionKey(store, state),
      stop: state.owner ? command('task-stop', id) : null,
      questions: state.status === 'awaiting_answer' ? (session?.lastReply?.questions ?? []) : [],
      findings: verdict?.findings ?? [],
      /** The reviewer's assessment of each lens in the verdict on display. */
      lenses: verdict?.lenses ?? [],
      /** Recorded quality lens evidence for the current attempt, latest last, without pending markers. */
      qualityEvidence: task.evidence.filter(item => item.kind === 'quality' && !item.id.endsWith(':requested')),
      ...executionRecords(store, execution),
    };
  });
}

type GuidedTaskView = ReturnType<typeof guidedTaskView>;

/** What a person approves: the brief, every command, provider and policy, and the approval digest. */
function draftLines(task: Task, state: GuidedState): string[] {
  const { plan } = state;
  const lines = [
    task.brief.outcome,
    `Plan: ${task.brief.plan}`,
    ...task.brief.criteria.map(item => `Criterion: ${item}`),
    `Repository: ${plan.workspace.repo}`,
    `Pinned base: ${plan.workspace.base}`,
    `Workspace: ${plan.workspace.path ?? 'Orca chooses the path'}`,
    `Implementation: ${plan.implementation.provider}, model ${plan.implementation.model ?? 'provider default'}, no time limit`,
    `Review: ${plan.review.provider}, model ${plan.review.model ?? 'provider default'}, no time limit`,
    'Automatic inference retries: 0. Delivery stays local.',
  ];
  if (plan.preparation)
    lines.push(
      `Preparation before implementation and checks (repository inputs unchanged): ${JSON.stringify(plan.preparation)}`,
    );
  plan.slices.forEach((slice, index) =>
    lines.push(
      '',
      `Slice ${index + 1}: ${task.brief.slices?.[index]?.title ?? task.brief.title}`,
      ...(slice.preparation
        ? [`Preparation after implementation (within authorized scope): ${JSON.stringify(slice.preparation)}`]
        : []),
      `Scope: ${JSON.stringify(slice.scope)}`,
      `Readiness: ${JSON.stringify(slice.readiness)}`,
      `Validation: ${JSON.stringify(slice.validation)}`,
      `Acceptance: ${JSON.stringify(slice.acceptance)}`,
      `Delivery: ${slice.mode}; ${slice.message}`,
    ),
  );
  lines.push('', `Approval digest: ${state.digest}`);
  const policy = plan.workflowPolicy;
  lines.push(
    `Workflow: ${policy.mode}; readiness repairs per slice: ${policy.readinessRounds}; shared behavioural repairs per slice: ${policy.repairRounds}; arbitrator: ${JSON.stringify(plan.reviewPolicy?.arbitrator ?? null)}.${policy.mode === 'supervised' ? ' Fresh authorization and quality assessment are required for each repair.' : ''}`,
    `Quality passes: ${plan.quality.passes.map(pass => `${pass.id} (${pass.kind})`).join(', ') || 'none'}.`,
  );
  if (plan.revision) lines.push(`Retained revision checkpoint: ${JSON.stringify(plan.revision)}`);
  return lines;
}

/** Questions, findings, lens verdicts, applied edit passes and checks on display. */
function evidenceLines(view: GuidedTaskView): string[] {
  const lines: string[] = [];
  for (const question of view.questions)
    lines.push(
      `Question [${question.id}]: ${question.prompt}`,
      ...(question.choices.length ? [`Choices: ${question.choices.join(' | ')}`] : []),
    );
  for (const finding of view.findings)
    lines.push(`Review ${finding.severity}: ${finding.description}`, `Evidence: ${finding.evidence}`);
  for (const lens of view.lenses) lines.push(`Lens ${lens.lens}: ${lens.verdict}. ${lens.summary}`);
  for (const edit of view.state.qualityEdits)
    lines.push(`Quality pass ${edit.pass}: ${edit.before === edit.after ? 'no changes' : 'applied changes'}`);
  for (const check of view.checks)
    lines.push(`${check.purpose === 'preparation' ? 'Preparation' : 'Check'}: ${check.spec.name} (${check.phase})`);
  return lines;
}

/** `--details`: retained repository instructions, every change and the full output of each check. */
function detailLines(store: Store, view: GuidedTaskView): string[] {
  const lines: string[] = [];
  const snapshot = guidedSnapshot(store, view.state);
  for (const instruction of snapshot?.instructions ?? [])
    lines.push('', `Instructions: ${instruction.path}`, instruction.content);
  for (const diff of snapshot?.diff ?? [])
    lines.push(
      '',
      `Change: ${diff.path}`,
      `Before (${diff.previousEncoding}):`,
      diff.previousContent ?? '(absent)',
      `After (${diff.encoding}):`,
      diff.content ?? '(absent)',
    );
  for (const check of view.checks)
    lines.push(
      '',
      `${check.spec.name} stdout:`,
      check.result?.stdout ?? '(unavailable)',
      'stderr:',
      check.result?.stderr ?? '(unavailable)',
      ...(check.error ? [check.error] : []),
    );
  return lines;
}

/**
 * Escapes control characters other than tab and line breaks, so agent or check text cannot move the
 * cursor, clear the screen or forge lines in the terminal that shows the view.
 */
function escapeControls(text: string): string {
  return Array.from(text, character => {
    const code = character.charCodeAt(0);
    const control = (code < 0x20 && character !== '\t' && character !== '\n' && character !== '\r') || code === 0x7f;
    return control ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }).join('');
}

/** The `task-show` text of a guided task; `details` adds instructions, changes and check output. */
export function renderGuidedTask(store: Store, id: string, details = false): string {
  const view = guidedTaskView(store, id),
    { task, state } = view;
  const lines = [
    task.brief.title,
    `Task: ${id}`,
    `Status: ${view.stale ? 'stale plan' : state.status}; step: ${state.stage}; slice ${state.sliceIndex + 1}/${state.plan.slices.length}`,
    `Requirements: ${task.version}; approved: ${task.approvedVersion ?? 'none'}`,
    state.note,
    '',
  ];
  if (state.status === 'draft') lines.push(...draftLines(task, state));
  lines.push(...spendingLines(spendingStatus(view.usage, state.plan.workflowPolicy)));
  if (view.workspace) lines.push(`Workspace: ${view.workspace.path ?? '(creation not settled)'}`);
  lines.push(
    `Guidance queued: ${state.guidance.length}; assigned to the current step: ${state.pending?.guidance.length ?? 0}. Assignment does not confirm the provider received or followed it.`,
  );
  for (const message of state.guidance)
    lines.push(`Guidance ${message.id} (${message.target}): ${JSON.stringify(message.text)}`);
  lines.push(
    `Repository context: ${state.plan.context.files.length}/${state.plan.context.totalFiles} initial pinned files supplied; ${state.plan.context.exploration ? 'agents can search and read repository files as needed' : 'other files are omitted from prompts, not from artifact verification'}.`,
    `Context files: ${state.plan.context.files.join(', ')}`,
    `Inventory digest: ${state.plan.context.inventoryDigest}`,
  );
  if (state.policy)
    lines.push(
      `Authorized file actions: ${JSON.stringify({ files: state.policy.files, create: state.policy.create, delete: state.policy.delete })}`,
    );
  if (state.status === 'awaiting_scope')
    lines.push(
      'Inspect the repository instructions and files before authorizing. Use --details for retained instructions and changes.',
    );
  lines.push(...evidenceLines(view));
  if (details) lines.push(...detailLines(store, view));
  if (view.recovery) lines.push('', 'Underlying recovery (same evidence requirements apply):', view.recovery);
  if (view.rerun)
    lines.push(
      '',
      'The check stopped for an infrastructure reason on the unchanged artifact. The next action reruns the same check without a new implementation attempt; task-retry starts a fresh attempt instead.',
    );
  lines.push('', ...view.usageSummary);
  if (view.stop) lines.push('', 'Request stop:', view.stop);
  lines.push(
    '',
    state.owner && state.status !== 'recovery_required'
      ? 'Controller ownership is retained; wait for it to exit before recovery.'
      : 'Next action:',
    view.next,
  );
  return escapeControls(lines.join('\n'));
}
