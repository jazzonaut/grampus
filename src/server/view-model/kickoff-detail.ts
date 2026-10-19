// Owns the planning page DTO (`KickoffDetailV1`) and the planning summary the overview lists: the
// discussion in readable form (answers as text, a proposal described rather than dumped as JSON), the
// pending questions, the proposal, its context and references, live planner activity and the actions.
import { serverLimits } from '../../config/limits.js';
import type { Kickoffs } from '../../orchestration/kickoff.js';
import type { ActivityV1, KickoffDetailV1, KickoffMessageV1, KickoffSummaryV1 } from '../api-types.js';
import { kickoffActions, type KickoffActionFacts } from './actions.js';
import type { ViewContext } from './context.js';
import { planView } from './plan.js';
import { folderName, kickoffPresentation, providerLabel, type TaskPresentation } from './status.js';

/** The kickoff view (`Kickoffs.view`). */
export type KickoffView = ReturnType<Kickoffs['view']>;

/** The conversation's title: the plan's, the request's provisional one, or the start of the request. */
export function kickoffTitle(kickoff: KickoffView): string {
  return kickoff.title ?? kickoff.config.request.slice(0, serverLimits.provisionalTitleCharacters);
}

const stringRecord = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(item => typeof item === 'string');

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A planning message for reading: answers become their text, a plan reply a short description. */
function messageView(kickoff: KickoffView, message: KickoffView['messages'][number]): KickoffMessageV1 {
  const value = parsed(message.text);
  if (message.role === 'user')
    return stringRecord(value)
      ? { role: 'user', author: 'You', at: message.at, kind: 'answers', text: Object.values(value).join('\n') }
      : { role: 'user', author: 'You', at: message.at, kind: 'message', text: message.text };
  const author = providerLabel(kickoff.config.provider);
  const brief = value && typeof value === 'object' && 'brief' in value ? value.brief : null;
  if (brief && typeof brief === 'object') {
    const named = 'title' in brief && typeof brief.title === 'string' ? brief.title : null;
    return {
      role: 'planner',
      author,
      at: message.at,
      kind: 'proposal',
      text: `I’ve prepared a plan for “${kickoff.title ?? named ?? kickoffTitle(kickoff)}”. Review its scope and checks below, or ask for changes.`,
    };
  }
  return { role: 'planner', author, at: message.at, kind: 'message', text: message.text };
}

function facts(kickoff: KickoffView, context: ViewContext): KickoffActionFacts {
  return {
    kickoffId: kickoff.id,
    turnKey: kickoff.turnKey,
    phase: kickoff.session.phase,
    run: kickoff.session.run !== null,
    jobRunning: context.job(kickoff.id)?.running ?? false,
    hasMessages: kickoff.messages.length > 0,
    questions: kickoff.session.phase === 'awaiting_answer' ? (kickoff.session.lastReply?.questions ?? []) : [],
    candidateDigest: kickoff.candidateDigest,
    error: kickoff.error,
    converted: kickoff.taskId !== null,
    context: { files: kickoff.config.files },
    references: kickoff.config.references.map(reference => reference.path),
  };
}

/** The planning conversation's presentation status. */
export function presentKickoff(kickoff: KickoffView, context: ViewContext): TaskPresentation {
  const f = facts(kickoff, context);
  return kickoffPresentation({
    phase: f.phase,
    jobRunning: f.jobRunning,
    uncertain: f.run || f.phase === 'recovery_required',
    hasProposal: !!kickoff.candidate && !kickoff.error,
    error: kickoff.error,
    converted: f.converted,
  });
}

const progressTitles = {
  connecting: 'Connecting to the agent',
  working: 'Agent is working',
  responding: 'Writing a response',
  finishing: 'Finishing the response',
  stopping: 'Stopping planning',
} as const;

function activity(kickoff: KickoffView, presentation: TaskPresentation): ActivityV1 | null {
  if (presentation.status !== 'working' && presentation.status !== 'stopping') return null;
  const progress = kickoff.progress;
  const title =
    presentation.status === 'stopping'
      ? progressTitles.stopping
      : progress
        ? progressTitles[progress.stage]
        : 'Starting the planner';
  return {
    title,
    description:
      presentation.status === 'stopping'
        ? 'Waiting for the agent to stop safely.'
        : (progress?.activity ?? 'Starting the planning session.'),
    actor: 'controller',
    provider: {
      id: kickoff.config.provider,
      label: providerLabel(kickoff.config.provider),
      model: kickoff.session.model,
    },
    stageLabel: 'Planning',
    startedAt: progress?.startedAt ?? null,
    lastActivityAt: progress?.lastActivityAt ?? null,
    repositoryCalls: progress?.repositoryCalls ?? null,
    integrationCalls: progress?.integrationCalls ?? null,
    fileRequests: null,
    recent: progress?.recent.map(item => item.label) ?? [],
  };
}

/**
 * The failure of this dashboard's last worker for the conversation once it has settled, or else the
 * latest journaled failure nothing has superseded, which is all that remains after a dashboard restart.
 */
function actionError(kickoff: KickoffView, context: ViewContext): KickoffDetailV1['actionError'] {
  const job = context.job(kickoff.id);
  if (job?.running) return null;
  if (job?.error) return { action: job.action, message: job.error, at: job.settledAt };
  const failure = kickoff.actionFailure;
  return failure ? { action: failure.action, message: failure.note, at: failure.at } : null;
}

/** `GET /api/v1/kickoffs/:id`. */
export function kickoffDetail(kickoff: KickoffView, context: ViewContext, revision: string): KickoffDetailV1 {
  const presentation = presentKickoff(kickoff, context);
  const { config } = kickoff;
  const actionFacts = facts(kickoff, context);
  return {
    apiVersion: 1,
    revision,
    id: kickoff.id,
    title: kickoffTitle(kickoff),
    status: presentation.status,
    statusLabel: presentation.label,
    explanation: presentation.explanation,
    request: config.request,
    repository: { name: folderName(config.repo), path: config.repo },
    base: config.base,
    provider: { id: config.provider, label: providerLabel(config.provider), model: kickoff.session.model },
    adapter: config.adapter,
    messages: kickoff.messages.map(message => messageView(kickoff, message)),
    questions: actionFacts.questions.map(question => ({
      id: question.id,
      prompt: question.prompt,
      suggestions: [...question.choices],
    })),
    proposal:
      kickoff.candidate && kickoff.candidateDigest
        ? { digest: kickoff.candidateDigest, plan: planView(kickoff.candidate) }
        : null,
    context: {
      // Every planning conversation explores the pinned repository itself; hints are optional.
      exploration: true,
      files: [...config.files],
      totalFiles: config.context.totalFiles,
      inventoryDigest: config.context.inventoryDigest,
      directories: config.context.directories.map(item => ({ ...item })),
    },
    references: config.references.map((reference, index) => ({
      label: `reference-${index + 1}`,
      path: reference.path,
      files: reference.totalFiles,
      base: reference.base,
    })),
    referenceSuggestions: kickoff.referenceSuggestions.map(item => ({ path: item.path, reason: item.reason })),
    activity: activity(kickoff, presentation),
    exploration: { calls: kickoff.exploration.calls, readFiles: [...kickoff.exploration.readFiles] },
    integrations: kickoff.integrations
      .filter(server => server.status === 'connected')
      .map(server => ({ name: server.name, status: server.status, tools: server.tools ?? null })),
    error: kickoff.error,
    actionError: actionError(kickoff, context),
    taskId: kickoff.taskId,
    actions: kickoffActions(actionFacts),
  };
}

/** The planning conversation in the overview list. */
export function kickoffSummary(kickoff: KickoffView, context: ViewContext): KickoffSummaryV1 {
  const presentation = presentKickoff(kickoff, context);
  return {
    id: kickoff.id,
    title: kickoffTitle(kickoff),
    repository: { name: folderName(kickoff.config.repo), path: kickoff.config.repo },
    status: presentation.status,
    statusLabel: presentation.label,
    provider: {
      id: kickoff.config.provider,
      label: providerLabel(kickoff.config.provider),
      model: kickoff.session.model,
    },
    lastActivityAt: kickoff.progress?.lastActivityAt ?? kickoff.messages.at(-1)?.at ?? null,
    needsAttention: presentation.attention !== null,
  };
}

/** The facts the kickoff action rules use; shared with the overview's attention items. */
export { facts as kickoffActionFacts };
