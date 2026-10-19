// Owns the home screen DTO (`OverviewV1`): health, the runner pool, the attention queue across tasks and
// planning conversations (most urgent first, each with one human sentence and its resolving actions),
// task and planning summaries, and recent verified deliveries. A task whose journal records cannot be
// read is listed with an unknown status and an attention item, so it never hides the others.
import { viewModelLimits } from '../../config/limits.js';
import type { HealthView } from '../../health/health.js';
import type { GuidedState } from '../../orchestration/guided/state.js';
import { RecordNotFoundError } from '../../persistence/errors.js';
import type { Store } from '../../persistence/store.js';
import { BoundaryError } from '../../process/boundary.js';
import type {
  ActionView,
  AttentionItem,
  AttentionKind,
  OverviewV1,
  RecentDeliveryV1,
  TaskSummaryV1,
} from '../api-types.js';
import { kickoffActions, kickoffResolvingActions, resolvingActionIds, taskActions } from './actions.js';
import { stallView, type ViewContext } from './context.js';
import { healthSummary } from './health.js';
import {
  kickoffActionFacts,
  kickoffSummary,
  kickoffTitle,
  presentKickoff,
  type KickoffView,
} from './kickoff-detail.js';
import { folderName, providerLabel, taskPresentation, type TaskPresentation } from './status.js';
import { taskActionFacts, taskFacts, taskWorkflow, type TaskFacts } from './task-detail.js';
import { usageHeadline, usageView } from './usage.js';

/** A guided task whose facts could not be read from the journal. */
export interface UnreadableTask {
  id: string;
  title: string;
  /** The task's own guided state when that still reads, for its repository and agents; otherwise null. */
  state: GuidedState | null;
  /** What failed, naming no content, e.g. `a missing snapshot record`. */
  category: string;
}

/** Everything the overview is computed from. */
export interface OverviewInputs {
  tasks: readonly TaskFacts[];
  /** Guided tasks whose facts could not be read; each is shown as unknown with an attention item. */
  unreadable: readonly UnreadableTask[];
  /** Planning conversations that have not become a task. */
  kickoffs: readonly KickoffView[];
  health: HealthView;
  application: {
    version: string;
    channel: string;
    build: { id: string; builtAt: string } | null;
  };
  journal: string;
  qualityPasses: readonly OverviewV1['qualityPasses'][number][];
}

/** Attention kinds in order of urgency: uncertain work first, then failures, silence, and waits. */
const urgency: readonly AttentionKind[] = [
  'recovery',
  'failed_check',
  'review_findings',
  'blocked',
  'resource_limit',
  'stalled',
  'question',
  'scope_authorization',
  'assessment',
  'approval',
  'plan_ready',
  'action_failed',
];

function taskAttention(facts: TaskFacts, context: ViewContext, presentation: TaskPresentation): AttentionItem[] {
  const { task, state } = facts.view;
  const actionFacts = taskActionFacts(facts, context);
  const actions = taskActions(actionFacts);
  const resolving = (ids: readonly string[]): ActionView[] =>
    actions.filter(item => ids.includes(item.id) && item.enabled);
  const item = (kind: AttentionKind, why: string, since: string | null, offered: ActionView[]): AttentionItem => ({
    id: `task:${task.id}:${kind}`,
    kind,
    taskId: task.id,
    kickoffId: null,
    title: task.brief.title,
    why,
    status: presentation.status,
    stopReason: state.stopReason?.code ?? null,
    since,
    actions: offered,
  });
  const items: AttentionItem[] = [];
  if (presentation.attention)
    items.push(
      item(
        presentation.attention,
        presentation.explanation,
        state.stopReason?.at ?? null,
        resolving(resolvingActionIds(actionFacts)),
      ),
    );
  const stall = stallView(context.stall(task.id));
  if (stall) items.push(item('stalled', stall.message, stall.since, resolving(['stop'])));
  const job = context.job(task.id);
  if (!items.length && job && !job.running && job.error)
    items.push(
      item('action_failed', `The last dashboard action (${job.action}) failed: ${job.error}`, job.settledAt, []),
    );
  return items;
}

function kickoffAttention(kickoff: KickoffView, context: ViewContext): AttentionItem[] {
  const presentation = presentKickoff(kickoff, context);
  if (!presentation.attention) return [];
  return [
    {
      id: `kickoff:${kickoff.id}:${presentation.attention}`,
      kind: presentation.attention,
      taskId: null,
      kickoffId: kickoff.id,
      title: kickoffTitle(kickoff),
      why: presentation.explanation,
      status: presentation.status,
      stopReason: null,
      since: kickoff.messages.at(-1)?.at ?? null,
      actions: kickoffResolvingActions(kickoffActions(kickoffActionFacts(kickoff, context))),
    },
  ];
}

function taskSummary(facts: TaskFacts, context: ViewContext, presentation: TaskPresentation): TaskSummaryV1 {
  const { task, state, progress } = facts.view;
  const workflow = taskWorkflow(facts, presentation);
  const current = workflow.find(stage => stage.state !== 'passed');
  const lastEvent = facts.events.at(-1)?.at ?? null;
  const lastProgress = progress?.lastActivityAt ?? null;
  return {
    id: task.id,
    title: task.brief.title,
    repository: { name: folderName(state.plan.workspace.repo), path: state.plan.workspace.repo },
    status: presentation.status,
    statusLabel: presentation.label,
    stageLabel: current?.label ?? 'Delivered',
    slice: { index: state.sliceIndex + 1, count: state.plan.slices.length },
    implementer: {
      id: state.plan.implementation.provider,
      label: providerLabel(state.plan.implementation.provider),
      model: state.plan.implementation.model,
    },
    reviewer: {
      id: state.plan.review.provider,
      label: providerLabel(state.plan.review.provider),
      model: state.plan.review.model,
    },
    lastActivityAt:
      lastProgress && lastEvent ? (lastProgress > lastEvent ? lastProgress : lastEvent) : (lastProgress ?? lastEvent),
    stalled: stallView(context.stall(task.id)),
    usage: usageHeadline(usageView(facts.view.usage)),
    needsAttention: presentation.attention !== null || context.stall(task.id) !== null,
  };
}

function deliveries(tasks: readonly TaskFacts[]): RecentDeliveryV1[] {
  return tasks
    .flatMap(facts => {
      const { task, state } = facts.view;
      const lenses = state.plan.quality.passes.filter(pass => pass.kind === 'lens').length;
      const evidence = [
        'Validation and acceptance verified by Grampus',
        `independent review by ${providerLabel(state.plan.review.provider)}`,
        ...(lenses ? [`${lenses} quality ${lenses === 1 ? 'lens' : 'lenses'} assessed`] : []),
      ].join('; ');
      // Slices are delivered once each, in order, so the n-th delivery is slice n.
      return facts.deliveries.map((delivery, index) => ({
        taskId: task.id,
        taskTitle: task.brief.title,
        slice: { index: index + 1, count: state.plan.slices.length },
        commit: delivery.commit,
        outcome: delivery.outcome,
        deliveredAt: delivery.at,
        evidence,
      }));
    })
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))
    .slice(0, viewModelLimits.recentDeliveries);
}

/** What kind of read failure `error` is, in words that name no record content. */
export function readFailureCategory(error: unknown): string {
  if (error instanceof RecordNotFoundError) return `a missing ${error.record.toLowerCase()} record`;
  if (error instanceof BoundaryError) return `an invalid ${error.kind.replaceAll('-', ' ')} (${error.source})`;
  return 'an unexpected read error';
}

/**
 * The facts of every guided task, in creation order. A task whose facts cannot be read is returned as
 * unreadable, with its error for the caller to log, instead of failing the whole overview.
 */
export function overviewTasks(store: Store): {
  tasks: TaskFacts[];
  unreadable: (UnreadableTask & { error: unknown })[];
} {
  const tasks: TaskFacts[] = [],
    unreadable: (UnreadableTask & { error: unknown })[] = [];
  for (const summary of store.guidedSummaries())
    try {
      tasks.push(taskFacts(store, summary.id));
    } catch (error) {
      let state: GuidedState | null = null;
      try {
        state = store.get(summary.id).guided ?? null;
      } catch {
        // The task record itself is unreadable; only its id and title are known.
      }
      unreadable.push({ id: summary.id, title: summary.title, state, category: readFailureCategory(error), error });
    }
  return { tasks, unreadable };
}

function unreadableAttention(task: UnreadableTask): AttentionItem {
  return {
    id: `task:${task.id}:blocked`,
    kind: 'blocked',
    taskId: task.id,
    kickoffId: null,
    title: task.title,
    why: `This task's journal records could not be read (${task.category}), so its state is unknown; inspect the journal before acting on it.`,
    status: 'unknown',
    stopReason: null,
    since: null,
    actions: [],
  };
}

/**
 * An unreadable task in the task list. One whose own record does not read has no repository or agents to
 * show, so it appears only as its attention item.
 */
function unreadableSummary(task: UnreadableTask): TaskSummaryV1 | null {
  const { state } = task;
  if (!state) return null;
  const agent = (role: GuidedState['plan']['review']) => ({
    id: role.provider,
    label: providerLabel(role.provider),
    model: role.model,
  });
  return {
    id: task.id,
    title: task.title,
    repository: { name: folderName(state.plan.workspace.repo), path: state.plan.workspace.repo },
    status: 'unknown',
    statusLabel: 'Cannot be read',
    stageLabel: 'Unknown',
    slice: { index: state.sliceIndex + 1, count: state.plan.slices.length },
    implementer: agent(state.plan.implementation),
    reviewer: agent(state.plan.review),
    lastActivityAt: null,
    stalled: null,
    usage: {
      tokens: null,
      cachedTokens: null,
      estimatedCostUsd: null,
      completeness: 'none',
      turns: 0,
      interventions: 0,
    },
    needsAttention: true,
  };
}

function byUrgency(a: AttentionItem, b: AttentionItem): number {
  const rank = urgency.indexOf(a.kind) - urgency.indexOf(b.kind);
  if (rank) return rank;
  return (a.since ?? '').localeCompare(b.since ?? '');
}

/** `GET /api/v1/overview`. */
export function overview(inputs: OverviewInputs, context: ViewContext, revision: string): OverviewV1 {
  const presented = inputs.tasks.map(facts => ({
    facts,
    presentation: taskPresentation(taskActionFacts(facts, context)),
  }));
  return {
    apiVersion: 1,
    revision,
    application: {
      name: 'Grampus',
      version: inputs.application.version,
      channel: inputs.application.channel,
      build: inputs.application.build
        ? { id: inputs.application.build.id, builtAt: inputs.application.build.builtAt }
        : null,
      journal: inputs.journal,
    },
    health: healthSummary(inputs.health),
    pool: { running: context.pool.active, limit: context.pool.limit, owners: [...context.pool.owners] },
    attention: [
      ...presented.flatMap(({ facts, presentation }) => taskAttention(facts, context, presentation)),
      ...inputs.unreadable.map(unreadableAttention),
      ...inputs.kickoffs.flatMap(kickoff => kickoffAttention(kickoff, context)),
    ].sort(byUrgency),
    tasks: [
      ...presented.map(({ facts, presentation }) => taskSummary(facts, context, presentation)),
      ...inputs.unreadable.flatMap(task => unreadableSummary(task) ?? []),
    ],
    planning: inputs.kickoffs.map(kickoff => kickoffSummary(kickoff, context)),
    recentDeliveries: deliveries(inputs.tasks),
    qualityPasses: inputs.qualityPasses.map(pass => ({ id: pass.id, title: pass.title, kind: pass.kind })),
  };
}
