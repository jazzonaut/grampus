import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { GuidedTasks, guidedQuestionKey } from './guided-tasks.js';
import { Sessions } from './sessions.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import type { Workspace } from './workspaces.js';
import type { RepositoryCheck } from './checks.js';
import type { Delivery } from './deliveries.js';
import type { ImplementationRun } from './implementations.js';
import { guidedPlanDigest } from './guided-plan.js';
import { explorationSummary } from './repository-tools.js';
import { integrationSummary } from './integrations.js';
import { taskUsage, usageLines } from './task-usage.js';

export function guidedTaskView(store: Store, id: string) {
  return store.transaction(() => {
  const task = new Workflow(store).get(id), state = new GuidedTasks(store).get(id);
  const workspace = store.workspaces<Workspace>().find(item => item.taskId === id) ?? null;
  const execution = state.executionId ? store.execution<Execution>(state.executionId) : null;
  const review = state.reviewId ? store.execution<Execution>(state.reviewId) : null;
  const session = state.stage === 'review' && review ? new Sessions(store).get(review.sessionId)
    : execution ? new Sessions(store).get(execution.sessionId) : null;
  const explorationEvents = [...new Set([execution?.sessionId, review?.sessionId].filter((id): id is string => !!id))]
    .flatMap(sessionId => store.sessionEvents(sessionId));
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = (...args: string[]) => `npm start -- --db ${quote(store.path)} ${args.map(quote).join(' ')}`;
  const stale = task.version !== state.version || JSON.stringify(task.brief) !== JSON.stringify(state.plan.brief) || guidedPlanDigest(state.plan) !== state.digest;
  let next: string;
  if (stale) next = command('show', id);
  else if (state.owner || state.pending || state.status === 'recovery_required') next = command('task-recover', id);
  else switch (state.status) {
    case 'draft': next = command('task-approve', id, String(state.version), state.digest); break;
    case 'awaiting_scope': next = command('task-authorize', id); break;
    case 'awaiting_assessment': next = `${command('task-assess', id)} --outcome '<passed|failed|skipped>' --summary '<your concrete simplification assessment>'`; break;
    case 'awaiting_answer': next = `${command('task-answer', id)} '<answers.json>'`; break;
    case 'blocked': next = command('task-retry', id); break;
    case 'complete': next = command('report', id); break;
    default: next = command('task-run', id);
  }
  const lease = workspace ? store.lease<ExecutionLease>(workspace.id) : null;
  const recovery = lease ? command(lease.kind === 'implementation' ? 'implementation-recover' : lease.kind === 'delivery' ? 'delivery-recover'
    : lease.kind === 'check' || lease.kind === 'verification' ? 'check-recover' : lease.readOnlyRecovery ? 'execution-recover' : 'session-recover',
  lease.readOnlyRecovery ? lease.executionId : lease.kind === 'conversation' ? lease.sessionId : lease.runId)
    : workspace && !['ready', 'released'].includes(workspace.phase) ? command('workspace-recover', workspace.id) : null;
  const usage = taskUsage(store, id);
  const currentVerdict = review ? new Sessions(store).get(review.sessionId).lastReply : null;
  const previousReview = state.reviewCycle?.history.at(-1);
  const carriedVerdict = !currentVerdict && previousReview
    ? new Sessions(store).get(store.execution<Execution>(previousReview.executionId).sessionId).lastReply : null;
  return { task, state, stale, workspace, lease, session, next, recovery, usage, usageSummary: usageLines(usage), carriedFindings: !!carriedVerdict, integrations: integrationSummary(session ? store.sessionEvents(session.id) : []), exploration: explorationSummary(explorationEvents), questionKey: guidedQuestionKey(store, state), stop: state.owner ? command('task-stop', id) : null,
    questions: state.status === 'awaiting_answer' ? session?.lastReply?.questions ?? [] : [],
    findings: (currentVerdict ?? carriedVerdict)?.findings ?? [],
    checks: execution ? store.checks<RepositoryCheck>(execution.id) : [],
    implementations: execution ? store.implementations<ImplementationRun>(execution.id) : [],
    deliveries: execution ? store.deliveries<Delivery>(execution.id) : [] };
  });
}

export function renderGuidedTask(store: Store, id: string, details = false): string {
  const view = guidedTaskView(store, id), { task, state } = view;
  const lines = [task.brief.title, `Task: ${id}`, `Status: ${view.stale ? 'stale plan' : state.status}; step: ${state.stage}; slice ${state.sliceIndex + 1}/${state.plan.slices.length}`,
    `Requirements: ${task.version}; approved: ${task.approvedVersion ?? 'none'}`, state.note, ''];
  if (state.status === 'draft') {
    lines.push(task.brief.outcome, `Plan: ${task.brief.plan}`, ...task.brief.criteria.map(item => `Criterion: ${item}`),
      `Repository: ${state.plan.workspace.repo}`, `Pinned base: ${state.plan.workspace.base}`,
      `Workspace: ${state.plan.workspace.path ?? 'Orca chooses the path'}`,
      `Implementation: ${state.plan.implementation.provider}, model ${state.plan.implementation.model ?? 'provider default'}, timeout ${state.plan.implementation.timeoutMs} ms`,
      `Review: ${state.plan.review.provider}, model ${state.plan.review.model ?? 'provider default'}, timeout ${state.plan.review.timeoutMs} ms`,
      'Automatic inference retries: 0. Delivery stays local.');
    state.plan.slices.forEach((slice, index) => lines.push('', `Slice ${index + 1}: ${task.brief.slices?.[index]?.title ?? task.brief.title}`,
      `Scope: ${JSON.stringify(slice.scope)}`, `Validation: ${JSON.stringify(slice.validation)}`,
      `Acceptance: ${JSON.stringify(slice.acceptance)}`, `Delivery: ${slice.mode}; ${slice.message}`));
    lines.push('', `Approval digest: ${state.digest}`);
    if (state.plan.reviewPolicy) lines.push(`Automatic repair allowance: ${state.plan.reviewPolicy.repairRounds}; arbitrator: ${JSON.stringify(state.plan.reviewPolicy.arbitrator ?? null)}. Fresh authorization and simplification are required for each repair.`);
    if (state.plan.revision) lines.push(`Retained revision checkpoint: ${JSON.stringify(state.plan.revision)}`);
  }
  if (view.workspace) lines.push(`Workspace: ${view.workspace.path ?? '(creation not settled)'}`);
  if (state.plan.context) lines.push(`Repository context: ${state.plan.context.files.length}/${state.plan.context.totalFiles} initial pinned files supplied; ${state.plan.context.exploration ? 'agents can search and read repository files as needed' : 'other files are omitted from prompts, not from artifact verification'}.`,
    `Context files: ${state.plan.context.files.join(', ')}`, `Inventory digest: ${state.plan.context.inventoryDigest}`);
  if (state.policy) lines.push(`Authorized file actions: ${JSON.stringify({ files: state.policy.files, create: state.policy.create, delete: state.policy.delete })}`);
  if (state.status === 'awaiting_scope') lines.push('Inspect the repository instructions and files before authorizing. Use --details for retained instructions and changes.');
  for (const question of view.questions) lines.push(`Question [${question.id}]: ${question.prompt}`, ...(question.choices.length ? [`Choices: ${question.choices.join(' | ')}`] : []));
  for (const finding of view.findings) lines.push(`Review ${finding.severity}: ${finding.description}`, `Evidence: ${finding.evidence}`);
  for (const check of view.checks) lines.push(`Check: ${check.spec.name} — ${check.phase}`);
  if (details) {
    for (const instruction of state.snapshot?.instructions ?? []) lines.push('', `Instructions: ${instruction.path}`, instruction.content);
    for (const diff of state.snapshot?.diff ?? []) lines.push('', `Change: ${diff.path}`, `Before (${diff.previousEncoding}):`, diff.previousContent ?? '(absent)', `After (${diff.encoding}):`, diff.content ?? '(absent)');
    for (const check of view.checks) lines.push('', `${check.spec.name} stdout:`, check.result?.stdout ?? '(unavailable)', 'stderr:', check.result?.stderr ?? '(unavailable)', ...(check.error ? [check.error] : []));
  }
  if (view.recovery) lines.push('', 'Underlying recovery (same evidence requirements apply):', view.recovery);
  lines.push('', ...view.usageSummary);
  if (view.stop) lines.push('', 'Request stop:', view.stop);
  lines.push('', state.owner && state.status !== 'recovery_required' ? 'Controller ownership is retained; wait for it to exit before recovery.' : 'Next action:', view.next);
  return lines.join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
