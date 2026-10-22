// The dashboard's visual language in one place: which icon and colour stands for each task status, step
// state, pipeline step and timeline event, and how times read. Pages never pick icons ad hoc.
import type { StoredEvent } from '../../src/domain/events';
import type { ComparisonStatus, StepId, StepState, TaskStatus, Tone } from '../../src/dashboard/types';

export type Color = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral';

export interface Look {
  icon: string;
  color: Color;
  label: string;
  /** Spin the icon: something is in progress. */
  spin?: boolean;
}

export const statusLook: Record<TaskStatus, Look> = {
  'needs-you': { icon: 'i-lucide-hand', color: 'warning', label: 'Needs you' },
  running: { icon: 'i-lucide-loader-circle', color: 'primary', label: 'Running', spin: true },
  stopped: { icon: 'i-lucide-octagon-pause', color: 'error', label: 'Driver stopped' },
  accepted: { icon: 'i-lucide-circle-check', color: 'success', label: 'Accepted' },
  abandoned: { icon: 'i-lucide-circle-x', color: 'neutral', label: 'Abandoned' },
  'not-selected': { icon: 'i-lucide-circle-slash', color: 'neutral', label: 'Not selected' },
};

export const comparisonStatusLook: Record<ComparisonStatus, Look> = {
  'needs-you': { icon: 'i-lucide-hand', color: 'warning', label: 'Pick a result' },
  running: { icon: 'i-lucide-loader-circle', color: 'primary', label: 'Running', spin: true },
  stopped: { icon: 'i-lucide-octagon-pause', color: 'error', label: 'Driver stopped' },
  picked: { icon: 'i-lucide-trophy', color: 'success', label: 'Picked' },
  abandoned: { icon: 'i-lucide-circle-x', color: 'neutral', label: 'Abandoned' },
};

export const stepStateLook: Record<StepState, Look> = {
  pending: { icon: 'i-lucide-circle-dashed', color: 'neutral', label: 'Not started' },
  running: { icon: 'i-lucide-loader-circle', color: 'primary', label: 'Running', spin: true },
  waiting: { icon: 'i-lucide-hand', color: 'warning', label: 'Waiting for you' },
  done: { icon: 'i-lucide-circle-check', color: 'success', label: 'Done' },
  failed: { icon: 'i-lucide-circle-alert', color: 'error', label: 'Failed' },
  skipped: { icon: 'i-lucide-circle-minus', color: 'neutral', label: 'Not in this recipe' },
};

export const stepIcon: Record<StepId, string> = {
  spec: 'i-lucide-file-text',
  'spec-review': 'i-lucide-file-search',
  approve: 'i-lucide-stamp',
  tests: 'i-lucide-flask-conical',
  baseline: 'i-lucide-ruler',
  build: 'i-lucide-hammer',
  verify: 'i-lucide-shield-check',
  review: 'i-lucide-scan-eye',
  repair: 'i-lucide-wrench',
  simplify: 'i-lucide-scissors',
  accept: 'i-lucide-flag',
};

export const toneColor: Record<Tone, Color> = {
  neutral: 'neutral',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/** Icons for timeline events; anything unlisted uses a dot. */
const eventIcons: Partial<Record<StoredEvent['type'], string>> = {
  'task.created': 'i-lucide-sparkles',
  'workspace.created': 'i-lucide-folder-git-2',
  'driver.started': 'i-lucide-play',
  'driver.stopped': 'i-lucide-octagon-pause',
  'run.created': 'i-lucide-workflow',
  'stage.started': 'i-lucide-bot',
  'stage.settled': 'i-lucide-bot-message-square',
  'stage.start_failed': 'i-lucide-bot-off',
  'stage.exited': 'i-lucide-bot-off',
  'stage.stopped': 'i-lucide-square',
  'stage.reuse_refused': 'i-lucide-refresh-cw-off',
  'worker.message': 'i-lucide-message-circle-question',
  'spec.recorded': 'i-lucide-file-text',
  'spec.rejected': 'i-lucide-file-x',
  'spec_review.recorded': 'i-lucide-file-search',
  'gate.created': 'i-lucide-lock',
  'gate.resolved': 'i-lucide-lock-open',
  'command.applied': 'i-lucide-user-check',
  'command.refused': 'i-lucide-user-x',
  'tests.recorded': 'i-lucide-flask-conical',
  'checks.recorded': 'i-lucide-list-checks',
  'guard.recorded': 'i-lucide-shield-check',
  'review.recorded': 'i-lucide-scan-eye',
  'round.decided': 'i-lucide-git-fork',
  'attention.needed': 'i-lucide-hand',
  'attention.withdrawn': 'i-lucide-undo-2',
  'workers.released': 'i-lucide-log-out',
  'usage.recorded': 'i-lucide-gauge',
  'task.finished': 'i-lucide-flag',
  'task.merged': 'i-lucide-git-merge',
};

export function eventIcon(type: StoredEvent['type']): string {
  return eventIcons[type] ?? 'i-lucide-dot';
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto', style: 'short' });
const absolute = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const clock = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' });

/** "4 min ago", "yesterday"... relative to `now`. */
export function ago(iso: string, now: number): string {
  const elapsed = Date.parse(iso) - now;
  const size = Math.abs(elapsed);
  if (size < minute) return 'just now';
  if (size < hour) return relative.format(Math.round(elapsed / minute), 'minute');
  if (size < day) return relative.format(Math.round(elapsed / hour), 'hour');
  return relative.format(Math.round(elapsed / day), 'day');
}

export function when(iso: string): string {
  return absolute.format(new Date(iso));
}

export function timeOfDay(iso: string): string {
  return clock.format(new Date(iso));
}

/** "1h 4m", "42s"; "?" for unknown, never zero. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '?';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '?' : value.toLocaleString('en-GB');
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : '?';
}

/** Estimated US dollars: cents, or more precision below a cent; "?" when unknown. */
export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '?';
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
