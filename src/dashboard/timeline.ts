// A task's timeline: one plain-language line per event worth showing. The mapped handler type makes a new
// event type a compile error here until it is described or deliberately hidden.
import type { StoredEvent } from '../domain/events.js';
import type { TimelineItem, Tone } from './types.js';

type Line = { title: string; detail?: string | null; tone?: Tone } | null;
type Describers = { [K in StoredEvent['type']]: (event: Extract<StoredEvent, { type: K }>) => Line };

const hidden = () => null;
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '?');

const describers: Describers = {
  'policy.decided': event => ({ title: `Automatic ${event.action}`, detail: event.reason }),
  'budget.checked': event => ({
    title: 'Delivery budget checked',
    detail: event.reason ?? `Estimated spend ${event.costUsd ?? 'unknown'}`,
  }),
  'review.workspace': event => ({ title: 'Isolated review checkout prepared', detail: event.path }),
  'review.preparing': hidden,
  'review.probe': event => ({
    title: event.result.passed ? 'Review probe passed' : 'Review probe failed',
    detail: event.scenario,
  }),
  'question.assessed': event => ({
    title: event.disposition === 'answer' ? 'Implementation question resolved' : 'Product decision needed',
    detail: event.body,
  }),
  'question.answered': event => ({ title: 'Worker answered by delivery policy', detail: event.body }),
  'polish.restored': event => ({ title: 'Verified commit restored', detail: short(event.sha) }),
  'tests.inherited': event => ({
    title: 'Acceptance tests shared',
    detail: `${event.files.length} files from ${event.fromTask} at ${short(event.sha)}`,
  }),
  'tests.baseline': event => ({
    title: 'Tests-first failure evidence',
    detail: event.assessments.map(item => `${item.name}: ${item.outcome}`).join('; '),
  }),
  'setup.configured': event => ({
    title: 'Repository setup configured',
    detail: event.command?.command ?? 'No setup required',
  }),
  'setup.started': event => ({ title: `Repository setup attempt ${event.attempt}`, detail: null }),
  'setup.recorded': event => ({
    title: event.result.passed && !event.problems.length ? 'Repository setup passed' : 'Repository setup failed',
    detail: event.problems.join('; ') || event.result.logPath,
    tone: event.result.passed && !event.problems.length ? 'success' : 'error',
  }),
  'log.header': hidden,
  'explanation.recorded': event => ({
    title: event.explanation ? 'Change explanation ready' : 'Change explanation unavailable',
    detail: event.error ?? short(event.candidateSha),
    tone: event.error ? 'warning' : 'info',
  }),
  'answer.recorded': event => ({
    title: event.answer ? 'Follow-up answered' : 'Follow-up unavailable',
    detail: event.error ?? event.question,
    tone: event.error ? 'warning' : 'info',
  }),
  'orca.requested': hidden,
  'task.created': event => ({ title: 'Task created', detail: `Recipe ${event.recipe.name}` }),
  'workspace.created': event => ({ title: 'Worktree created', detail: `${event.path} at ${short(event.baseSha)}` }),
  'driver.started': event => ({
    title: 'Driver started',
    detail: [event.build ? `Grampus ${event.build}` : null, event.orcaVersion ? `Orca ${event.orcaVersion}` : null]
      .filter(Boolean)
      .join(', '),
  }),
  'driver.stopped': event => ({ title: 'Driver stopped', detail: event.reason, tone: 'error' }),
  'orca.busy': event => ({ title: 'Orca busy, waiting for room', detail: event.detail, tone: 'warning' }),
  'orca.room': event => ({ title: 'Orca has room again', detail: `after ${Math.round(event.waitedMs / 1000)} s` }),
  'orca.uncertain': event => ({ title: `Orca call repeated (${event.repeat})`, detail: event.detail, tone: 'warning' }),
  'run.created': () => ({ title: 'Orca run created' }),
  'stage.created': event => ({ title: `${event.key} created` }),
  'stage.started': event => ({
    title: `${event.key} started`,
    detail: [
      event.assignment?.agent,
      event.assignment?.model,
      event.assignment?.effort,
      event.reusedHandle ? 'continuing the previous conversation' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    tone: 'info',
  }),
  'stage.reuse_refused': event => ({
    title: `${event.key}: conversation could not be continued`,
    detail: 'A fresh worker starts instead.',
    tone: 'warning',
  }),
  'stage.start_failed': event => ({ title: `${event.key} failed to start`, detail: event.error, tone: 'error' }),
  'stage.settled': event => ({
    title: `${event.key} ${event.outcome === 'succeeded' ? 'finished' : 'reported failure'}`,
    detail: event.subject,
    tone: event.outcome === 'succeeded' ? 'success' : 'error',
  }),
  'stage.exited': event => ({ title: `${event.key} worker exited`, tone: 'error' }),
  'stage.stopped': event => ({ title: `${event.key} stopped`, detail: event.reason, tone: 'neutral' }),
  'worker.message': event => ({
    title:
      event.kind === 'question'
        ? `${event.key ?? 'Worker'} asked a question`
        : `${event.key ?? 'Worker'}: ${event.kind}`,
    detail: event.subject,
    tone: event.kind === 'question' ? 'warning' : 'neutral',
  }),
  'spec.recorded': event => ({
    title: `Spec v${event.version} recorded`,
    detail: `${event.checks.length} checks${event.protected.length ? `, ${event.protected.length} protected paths` : ''}`,
    tone: 'success',
  }),
  'spec.inherited': event => ({
    title: 'Shared spec received',
    detail: `Spec v${event.fromVersion} approved in ${event.fromTask}, ${event.checks.length} checks`,
    tone: 'success',
  }),
  'spec.rejected': event => ({ title: 'Spec file unusable', detail: event.error, tone: 'warning' }),
  'spec_review.recorded': event => ({
    title: `Spec v${event.specVersion} reviewed`,
    detail: event.report ? `${event.report.verdict}: ${event.report.summary}` : event.error,
    tone: event.report ? 'info' : 'warning',
  }),
  'gate.created': () => ({ title: 'Approval gate created' }),
  'gate.resolved': event => ({ title: 'Approval gate resolved', detail: event.resolution, tone: 'success' }),
  'command.applied': event => ({
    title: `${event.command.kind} applied`,
    detail: `from ${event.command.source}`,
    tone: 'info',
  }),
  'command.refused': event => ({ title: `${event.command.kind} refused`, detail: event.reason, tone: 'warning' }),
  'tests.recorded': event => ({
    title: 'Acceptance tests committed',
    detail: `${event.files.length} files at ${short(event.sha)}`,
    tone: 'success',
  }),
  'checks.recorded': event => {
    const passed = event.results.filter(result => result.passed).length;
    const all = passed === event.results.length;
    return {
      title:
        event.phase === 'spec'
          ? `Spec v${event.round} checks on the original commit`
          : event.phase === 'baseline'
            ? 'Baseline checks'
            : `Round ${event.round} checks`,
      detail: `${passed}/${event.results.length} pass at ${short(event.sha)}`,
      tone: event.phase === 'verify' ? (all ? 'success' : 'error') : 'neutral',
    };
  },
  'guard.recorded': event => ({
    title: `Round ${event.round} integrity guard`,
    detail: event.guard.violations.length
      ? event.guard.violations.join('; ')
      : `${event.guard.commits} commits, ${event.guard.changedFiles.length} files changed`,
    tone: event.guard.violations.length ? 'error' : 'success',
  }),
  'review.recorded': event => ({
    title: `Round ${event.round} reviewed`,
    detail: event.report ? `${event.report.verdict}, ${event.blocking.length} blocking` : event.error,
    tone: !event.report ? 'warning' : event.blocking.length ? 'error' : 'success',
  }),
  'round.decided': event => ({
    title: `Round ${event.round}: ${event.decision}`,
    detail: event.reasons.join('; ') || null,
    tone: event.decision === 'ready' ? 'success' : event.decision === 'repair' ? 'warning' : 'error',
  }),
  'attention.needed': event => ({ title: 'Needs you', detail: event.detail, tone: 'warning' }),
  'attention.withdrawn': event => ({ title: 'No longer needs you', detail: event.why }),
  'polish.checked': event => {
    const passed = event.results.filter(result => result.passed).length;
    return {
      title: `Round ${event.round} polish checked`,
      detail: event.guard.violations.length
        ? event.guard.violations.join('; ')
        : `${passed}/${event.results.length} checks pass at ${short(event.sha)}`,
      tone: 'neutral',
    };
  },
  'polish.decided': event => ({
    title: `Round ${event.round} polish ${event.outcome === 'noop' ? 'found no worthwhile change' : event.outcome}`,
    detail: event.kept
      ? (event.report?.improvements.map(item => item.benefit).join('; ') ?? short(event.sha))
      : event.reasons.join('; ') || event.report?.summary || null,
    tone: event.kept ? 'success' : 'neutral',
  }),
  'workers.released': event => ({
    title: 'Workers released',
    detail: event.failures.length ? `${event.failures.length} could not be released` : null,
  }),
  'usage.recorded': event => ({ title: 'Usage measured', detail: `${event.measurements.length} dispatches` }),
  'task.finished': event => ({
    title:
      event.outcome === 'not-selected'
        ? 'Not selected: another comparison entry was picked'
        : `Task ${event.outcome}${event.override ? ' with unresolved problems' : ''}`,
    detail: event.reason ?? (event.sha ? `at ${short(event.sha)}` : null),
    tone: event.outcome === 'accepted' ? 'success' : 'neutral',
  }),
  'task.merged': event => ({ title: `Merged into ${event.branch}`, detail: short(event.sha), tone: 'success' }),
};

/** Timeline lines for a task's events, oldest first. */
export function timelineOf(events: readonly StoredEvent[]): TimelineItem[] {
  return events.flatMap(event => {
    const line = (describers[event.type] as (event: StoredEvent) => Line)(event);
    return line
      ? [
          {
            at: event.at,
            type: event.type,
            title: line.title,
            detail: line.detail || null,
            tone: line.tone ?? 'neutral',
          },
        ]
      : [];
  });
}
