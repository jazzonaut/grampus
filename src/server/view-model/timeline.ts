// Owns the task timeline as the dashboard shows it: each journal event with a short human summary, its
// note in UI language and its reason code, paged newest first by journal sequence.
import { z } from 'zod';
import { serverLimits, viewModelLimits } from '../../config/limits.js';
import type { JournalEvent } from '../../persistence/store.js';
import type { Stage } from '../../orchestration/guided/state.js';
import { outputExcerpt } from '../../verification/check-output.js';
import type { TimelineEntryV1, TimelinePageV1 } from '../api-types.js';
import { humanNote, stopPresentation } from './status.js';
import { repairDecision } from './repairs.js';
import type { StopReasonCode } from '../../orchestration/guided/stop-reasons.js';

const stageNames: Readonly<Record<Stage, string>> = {
  workspace: 'workspace setup',
  execution: 'implementation setup',
  preparation: 'preparation',
  scope: 'workspace checkpoint',
  implementation: 'implementation',
  quality_pass: 'quality pass',
  refresh: 'check preparation',
  readiness: 'implementation readiness',
  validation: 'validation',
  submission: 'submission',
  assessment: 'quality assessment',
  review_execution: 'review setup',
  review: 'independent review',
  verification: 'acceptance',
  delivery: 'local delivery',
  complete: 'completion',
};

/** Fixed summaries of event types; anything else is described from its type name. */
const summaries: Readonly<Record<string, string>> = {
  'task.created': 'Task created',
  'guided.created': 'Plan prepared for approval',
  'guided.kickoff_linked': 'Linked to its planning conversation',
  'guided.approved': 'Plan approved',
  'guided.revised': 'Plan revised; fresh approval needed',
  'guided.controller_claimed': 'Controller started',
  'guided.controller_reconciled': 'Controller state reconciled',
  'guided.scope_authorized': 'Workspace execution confirmed',
  'guided.assessment_supplied': 'Quality assessment recorded',
  'guided.answers_supplied': 'Answers sent',
  'guided.diagnostic_allowance_approved': 'Additional diagnostic attempts approved',
  'guided.retry_requested': 'Repair attempt requested',
  'guided.comparison_retry_queued': 'Comparison repair retry queued',
  'guided.repair_decided': 'Repair policy decision',
  'guided.preparation_retry_requested': 'Preparation retry requested',
  'guided.review_retry_requested': 'Review retry requested',
  'guided.checks_rerun_requested': 'Check rerun requested',
  'guided.recovery_requested': 'Recovery requested',
  'guided.recovery_blocked': 'Recovery could not prove what happened',
  'guided.workspace_released': 'Unused workspace reservation released',
  'guided.stop_requested': 'Stop requested',
  'guided.pause_requested': 'Pause requested after the current operation',
  'guided.paused': 'Paused between operations',
  'guided.continued': 'Task continued',
  'guided.guidance_queued': 'Human guidance queued',
  'guided.guidance_cancelled': 'Queued guidance cancelled',
  'guided.guidance_waiting': 'Delivery waits for a guidance decision',
  'guided.spending_blocked': 'Task spending policy stopped another agent turn',
  'guided.stopped_between_steps': 'Stopped between steps',
  'guided.validation_repair_requested': 'Automatic repair after a failed check',
  'guided.readiness_repair_requested': 'Automatic repair after a readiness check',
  'guided.acceptance_repair_requested': 'Automatic repair after failed acceptance',
  'guided.review_repair_requested': 'Automatic repair of review findings',
  'guided.arbitration_requested': 'Fresh arbitration requested',
  'guided.blocking_review': 'Review found blocking issues',
  'guided.check_failed': 'Check failed',
  'guided.stall_detected': 'Possibly stalled: no activity',
  'check.requested': 'Check requested',
  'check.settled': 'Check settled',
  'delivery.requested': 'Local delivery requested',
  'delivery.settled': 'Local delivery settled',
  'slice.delivered': 'Slice delivered',
  'task.completed': 'Task complete',
  'evidence.recorded': 'Evidence recorded',
  'dashboard.action_failed': 'Dashboard action failed',
  'execution.created': 'Agent conversation prepared',
  'implementation.settled': 'Implementation turn settled',
};

const eventData = z.looseObject({
  note: z.string().exactOptional(),
  reasonCode: z.string().nullable().exactOptional(),
  stage: z.string().exactOptional(),
  status: z.string().exactOptional(),
  action: z.string().exactOptional(),
  message: z.object({ text: z.string() }).exactOptional(),
});

const isStage = (value: string | undefined): value is Stage => value !== undefined && value in stageNames;
const isStopCode = (value: string): value is StopReasonCode => value in stopPresentation;

function summary(event: JournalEvent, data: z.infer<typeof eventData>): string {
  const stage = isStage(data.stage) ? stageNames[data.stage] : null;
  if (event.type === 'guided.step_requested' && stage) return `Started ${stage}`;
  if (event.type === 'guided.step_finished' && stage) return `Finished ${stage}`;
  if (event.type === 'guided.step_failed' && stage) return `Stopped during ${stage}`;
  if (event.type === 'guided.blocked' && data.reasonCode && isStopCode(data.reasonCode))
    return `Stopped: ${stopPresentation[data.reasonCode].label}`;
  if (event.type === 'dashboard.action_failed' && data.action) return `Dashboard action failed: ${data.action}`;
  const fixed = summaries[event.type];
  if (fixed) return fixed;
  const words = event.type.replaceAll('.', ' ').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One event as the timeline shows it; the note is bounded and in UI language. */
export function timelineEntry(event: JournalEvent): TimelineEntryV1 {
  const data = eventData.safeParse(event.data).data ?? {};
  const decision = repairDecision(event);
  const guidance = event.type === 'guided.guidance_queued' ? data.message?.text : null;
  const note = data.note ? humanNote(outputExcerpt(data.note, serverLimits.eventNoteCharacters)).trim() : '';
  return {
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    summary: decision?.title ?? summary(event, data),
    note:
      guidance ??
      (decision ? `${decision.trigger}\n${decision.reason} ${decision.progress} ${decision.budget}` : note || null),
    reasonCode: data.reasonCode ?? null,
  };
}

/** The latest entries, newest first. */
export function recentTimeline(events: readonly JournalEvent[]): TimelineEntryV1[] {
  return events.slice(-viewModelLimits.recentTimelineEntries).reverse().map(timelineEntry);
}

/** A page of the timeline, newest first, strictly older than `cursor` when one is given. */
export function timelinePage(
  taskId: string,
  events: readonly JournalEvent[],
  cursor: number | null,
  limit: number,
): TimelinePageV1 {
  const older = cursor === null ? events : events.filter(event => event.sequence < cursor);
  const page = older.slice(-limit);
  return {
    apiVersion: 1,
    taskId,
    total: events.length,
    entries: [...page].reverse().map(timelineEntry),
    nextCursor: older.length > page.length ? (page[0]?.sequence ?? null) : null,
  };
}
