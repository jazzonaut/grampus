import type { Store } from '../persistence/store.js';
import { Workflow } from '../domain/workflow.js';
import { GuidedTasks } from './guided/controller.js';
import { guidedDecisionDigest, guidedQuestionKey } from './guided/keys.js';
import { rerunChecksIneligibility } from './guided/rerun.js';
import { selectedLenses } from '../domain/quality-passes.js';
import { Sessions } from '../execution/sessions.js';
import type { Execution, ExecutionLease } from '../execution/execution-state.js';
import type { Workspace } from '../repository/workspaces.js';
import type { RepositoryCheck } from '../verification/checks.js';
import type { Delivery } from '../execution/deliveries.js';
import type { ImplementationRun } from '../execution/implementations.js';
import { guidedPlanDigest, reviewRepairRounds } from '../domain/guided-plan.js';
import { deepEqual } from '../domain/deep-equal.js';
import { explorationSummary } from '../repository/repository-tools.js';
import { integrationSummary } from '../providers/integrations.js';
import { taskUsage, usageLines } from '../reporting/task-usage.js';
import { agentProgress } from './planner-progress.js';

export function guidedTaskView(store: Store, id: string) {
  return store.transaction(() => {
    const task = new Workflow(store).get(id),
      state = new GuidedTasks(store).get(id);
    const workspace = store.workspaces<Workspace>().find(item => item.taskId === id) ?? null;
    const execution = state.executionId ? store.execution<Execution>(state.executionId) : null;
    const review = state.reviewId ? store.execution<Execution>(state.reviewId) : null;
    const session =
      state.stage === 'review' && review
        ? new Sessions(store).get(review.sessionId)
        : execution
          ? new Sessions(store).get(execution.sessionId)
          : null;
    const explorationEvents = [
      ...new Set([execution?.sessionId, review?.sessionId].filter((id): id is string => !!id)),
    ].flatMap(sessionId => store.sessionEvents(sessionId));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = (...args: string[]) => `npm start -- --db ${quote(store.path)} ${args.map(quote).join(' ')}`;
    const stale =
      task.version !== state.version ||
      !deepEqual(task.brief, state.plan.brief) ||
      guidedPlanDigest(state.plan) !== state.digest;
    // Rerunning checks is offered only for a settled infrastructure stop on the unchanged artifact.
    const rerun =
      !stale && !state.owner && !rerunChecksIneligibility(store, task)
        ? command('task-rerun-checks', id, guidedDecisionDigest(state, guidedQuestionKey(store, state)))
        : null;
    let next: string;
    if (stale) next = command('show', id);
    else if (state.owner || state.pending || state.status === 'recovery_required') next = command('task-recover', id);
    else
      switch (state.status) {
        case 'draft':
          next = command('task-approve', id, String(state.version), state.digest);
          break;
        case 'awaiting_scope':
          next = command('task-authorize', id);
          break;
        case 'awaiting_assessment':
          next = `${command('task-assess', id)} --outcome '<passed|failed|skipped>' --summary '<your concrete assessment covering ${selectedLenses(
            state.plan.quality,
          )
            .map(lens => lens.id)
            .join(', ')}>'`;
          break;
        case 'awaiting_answer':
          next = `${command('task-answer', id)} '<answers.json>'`;
          break;
        case 'blocked':
          next = rerun ?? command('task-retry', id);
          break;
        case 'complete':
          next = command('report', id);
          break;
        default:
          next = command('task-run', id);
      }
    const lease = workspace ? store.lease<ExecutionLease>(workspace.id) : null;
    const recovery = lease
      ? command(
          lease.kind === 'implementation'
            ? 'implementation-recover'
            : lease.kind === 'delivery'
              ? 'delivery-recover'
              : lease.kind === 'check' || lease.kind === 'verification'
                ? 'check-recover'
                : lease.readOnlyRecovery
                  ? 'execution-recover'
                  : 'session-recover',
          lease.readOnlyRecovery ? lease.executionId : lease.kind === 'conversation' ? lease.sessionId : lease.runId,
        )
      : workspace && !['ready', 'released'].includes(workspace.phase)
        ? command('workspace-recover', workspace.id)
        : null;
    const usage = taskUsage(store, id);
    const progress =
      session && (state.stage === 'implementation' || state.stage === 'quality_pass' || state.stage === 'review')
        ? agentProgress(
            store.sessionEvents(session.id),
            session,
            state.stage === 'review' ? 'review' : 'implementation',
          )
        : null;
    const currentVerdict = review ? new Sessions(store).get(review.sessionId).lastReply : null;
    const previousReview = state.reviewCycle.history.at(-1);
    const carriedVerdict =
      !currentVerdict && previousReview
        ? new Sessions(store).get(store.execution<Execution>(previousReview.executionId).sessionId).lastReply
        : null;
    return {
      task,
      state,
      stale,
      workspace,
      lease,
      session,
      progress,
      next,
      rerun,
      recovery,
      usage,
      usageSummary: usageLines(usage),
      carriedFindings: !!carriedVerdict,
      integrations: integrationSummary(session ? store.sessionEvents(session.id) : []),
      exploration: explorationSummary(explorationEvents),
      questionKey: guidedQuestionKey(store, state),
      stop: state.owner ? command('task-stop', id) : null,
      questions: state.status === 'awaiting_answer' ? (session?.lastReply?.questions ?? []) : [],
      findings: (currentVerdict ?? carriedVerdict)?.findings ?? [],
      /** The reviewer's assessment of each lens in the verdict on display. */
      lenses: (currentVerdict ?? carriedVerdict)?.lenses ?? [],
      /** Recorded quality lens evidence for the current attempt, latest last. */
      qualityEvidence: task.evidence.filter(item => item.kind === 'quality' && !item.id.endsWith(':requested')),
      checks: execution ? store.checks<RepositoryCheck>(execution.id) : [],
      implementations: execution ? store.implementations<ImplementationRun>(execution.id) : [],
      deliveries: execution ? store.deliveries<Delivery>(execution.id) : [],
    };
  });
}

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
  if (state.status === 'draft') {
    lines.push(
      task.brief.outcome,
      `Plan: ${task.brief.plan}`,
      ...task.brief.criteria.map(item => `Criterion: ${item}`),
      `Repository: ${state.plan.workspace.repo}`,
      `Pinned base: ${state.plan.workspace.base}`,
      `Workspace: ${state.plan.workspace.path ?? 'Orca chooses the path'}`,
      `Implementation: ${state.plan.implementation.provider}, model ${state.plan.implementation.model ?? 'provider default'}, no time limit`,
      `Review: ${state.plan.review.provider}, model ${state.plan.review.model ?? 'provider default'}, no time limit`,
      'Automatic inference retries: 0. Delivery stays local.',
    );
    if (state.plan.preparation)
      lines.push(
        `Preparation before implementation and checks (repository inputs unchanged): ${JSON.stringify(state.plan.preparation)}`,
      );
    state.plan.slices.forEach((slice, index) =>
      lines.push(
        '',
        `Slice ${index + 1}: ${task.brief.slices?.[index]?.title ?? task.brief.title}`,
        ...(slice.preparation
          ? [`Preparation after implementation (within authorized scope): ${JSON.stringify(slice.preparation)}`]
          : []),
        `Scope: ${JSON.stringify(slice.scope)}`,
        `Validation: ${JSON.stringify(slice.validation)}`,
        `Acceptance: ${JSON.stringify(slice.acceptance)}`,
        `Delivery: ${slice.mode}; ${slice.message}`,
      ),
    );
    lines.push('', `Approval digest: ${state.digest}`);
    const policy = state.plan.workflowPolicy;
    lines.push(
      `Workflow: ${policy.mode}; check repairs per slice: ${policy.repairRounds}; review repairs: ${reviewRepairRounds(state.plan)}; arbitrator: ${JSON.stringify(state.plan.reviewPolicy?.arbitrator ?? null)}.${policy.mode === 'supervised' ? ' Fresh authorization and quality assessment are required for each repair.' : ''}`,
      `Quality passes: ${state.plan.quality.passes.map(pass => `${pass.id} (${pass.kind})`).join(', ') || 'none'}.`,
    );
    if (state.plan.revision) lines.push(`Retained revision checkpoint: ${JSON.stringify(state.plan.revision)}`);
  }
  if (view.workspace) lines.push(`Workspace: ${view.workspace.path ?? '(creation not settled)'}`);
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
  for (const question of view.questions)
    lines.push(
      `Question [${question.id}]: ${question.prompt}`,
      ...(question.choices.length ? [`Choices: ${question.choices.join(' | ')}`] : []),
    );
  for (const finding of view.findings)
    lines.push(`Review ${finding.severity}: ${finding.description}`, `Evidence: ${finding.evidence}`);
  for (const lens of view.lenses) lines.push(`Lens ${lens.lens}: ${lens.verdict}. ${lens.summary}`);
  for (const edit of state.qualityEdits)
    lines.push(`Quality pass ${edit.pass}: ${edit.before === edit.after ? 'no changes' : 'applied changes'}`);
  for (const check of view.checks)
    lines.push(`${check.purpose === 'preparation' ? 'Preparation' : 'Check'}: ${check.spec.name} — ${check.phase}`);
  if (details) {
    for (const instruction of state.snapshot?.instructions ?? [])
      lines.push('', `Instructions: ${instruction.path}`, instruction.content);
    for (const diff of state.snapshot?.diff ?? [])
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
  }
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
  return lines
    .join('\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
