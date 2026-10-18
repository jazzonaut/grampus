// How each status and workflow stage state looks: label, icon and semantic colour.
// Status is never shown by colour alone, so every entry has a label and an icon.
import type { SemanticColor } from './tokens';

/** Statuses the dashboard can show for a task, step or piece of evidence. */
export const statuses = [
  'working',
  'awaiting_human',
  'verified',
  'failed',
  'blocked',
  'unknown',
  'provider_reported',
  'idle',
  'complete',
] as const;

export type Status = (typeof statuses)[number];

/** Label, icon and colour for one status or stage state. */
export interface Presentation {
  readonly label: string;
  /** A Lucide icon name; literal so the build bundles it (see vite.config.ts). */
  readonly icon: string;
  readonly color: SemanticColor;
}

export const statusPresentation: Readonly<Record<Status, Presentation>> = {
  working: { label: 'Working', icon: 'i-lucide-loader-circle', color: 'info' },
  awaiting_human: { label: 'Needs you', icon: 'i-lucide-hand', color: 'warning' },
  verified: { label: 'Verified', icon: 'i-lucide-shield-check', color: 'success' },
  failed: { label: 'Failed', icon: 'i-lucide-circle-x', color: 'error' },
  blocked: { label: 'Blocked', icon: 'i-lucide-octagon-pause', color: 'warning' },
  unknown: { label: 'Unknown', icon: 'i-lucide-circle-help', color: 'neutral' },
  provider_reported: { label: 'Provider reported', icon: 'i-lucide-message-square-quote', color: 'reported' },
  idle: { label: 'Idle', icon: 'i-lucide-circle-dashed', color: 'neutral' },
  complete: { label: 'Complete', icon: 'i-lucide-circle-check-big', color: 'success' },
};

/** States of one workflow stage. */
export const stageStates = ['passed', 'pending', 'active', 'failed', 'unknown', 'skipped'] as const;

export type StageState = (typeof stageStates)[number];

export const stagePresentation: Readonly<Record<StageState, Presentation>> = {
  passed: { label: 'Passed', icon: 'i-lucide-circle-check', color: 'success' },
  pending: { label: 'Pending', icon: 'i-lucide-circle', color: 'neutral' },
  active: { label: 'In progress', icon: 'i-lucide-loader-circle', color: 'info' },
  failed: { label: 'Failed', icon: 'i-lucide-circle-x', color: 'error' },
  unknown: { label: 'Unknown', icon: 'i-lucide-circle-help', color: 'neutral' },
  skipped: { label: 'Skipped', icon: 'i-lucide-circle-slash', color: 'neutral' },
};
