// How each status and workflow stage state looks: label, icon and semantic colour.
// Status is never shown by colour alone, so every entry has a label and an icon.
// The vocabularies are the server's (src/server/api-types.ts); the server decides which applies.
import type {
  EvidenceSource,
  IntegrationStatusV1,
  OverallHealth,
  PresentationStatus,
  StageState,
} from '../../../src/server/api-types';
import type { SemanticColor } from './tokens';

/**
 * Statuses the dashboard can show: the server's presentation statuses, plus `provider_reported` for
 * evidence an agent claimed but Grampus did not verify.
 */
export type Status = PresentationStatus | 'provider_reported';

/** Every status, in display order. `statusPresentation` is keyed by `Status`, so a new one must be described there. */
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
  'stopping',
] as const satisfies readonly Status[];

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
  stopping: { label: 'Stopping', icon: 'i-lucide-circle-stop', color: 'warning' },
};

export type { StageState };

/** States of one workflow stage. */
export const stageStates = [
  'passed',
  'pending',
  'active',
  'failed',
  'unknown',
  'skipped',
] as const satisfies readonly StageState[];

export const stagePresentation: Readonly<Record<StageState, Presentation>> = {
  passed: { label: 'Passed', icon: 'i-lucide-circle-check', color: 'success' },
  pending: { label: 'Pending', icon: 'i-lucide-circle', color: 'neutral' },
  active: { label: 'In progress', icon: 'i-lucide-loader-circle', color: 'info' },
  failed: { label: 'Failed', icon: 'i-lucide-circle-x', color: 'error' },
  unknown: { label: 'Unknown', icon: 'i-lucide-circle-help', color: 'neutral' },
  skipped: { label: 'Skipped', icon: 'i-lucide-circle-slash', color: 'neutral' },
};

/** Overall integration health. Labels come from the server; these are the icon and colour. */
export const healthPresentation: Readonly<Record<OverallHealth, Omit<Presentation, 'label'>>> = {
  ready: { icon: 'i-lucide-shield-check', color: 'success' },
  degraded: { icon: 'i-lucide-triangle-alert', color: 'warning' },
  blocked: { icon: 'i-lucide-octagon-x', color: 'error' },
  unknown: { icon: 'i-lucide-circle-help', color: 'neutral' },
};

/** One integration or capability status as `doctor` recorded it; labels come from the server. */
export const integrationPresentation: Readonly<Record<IntegrationStatusV1, Omit<Presentation, 'label'>>> = {
  healthy: { icon: 'i-lucide-circle-check', color: 'success' },
  failed: { icon: 'i-lucide-circle-x', color: 'error' },
  untested: { icon: 'i-lucide-circle-dashed', color: 'neutral' },
  not_configured: { icon: 'i-lucide-circle-minus', color: 'neutral' },
  auth_unavailable: { icon: 'i-lucide-key-round', color: 'warning' },
  temporarily_unavailable: { icon: 'i-lucide-clock-alert', color: 'warning' },
};

/** Text colour classes per semantic colour, literal so Tailwind finds them. */
export const textTone: Readonly<Record<SemanticColor, string>> = {
  primary: 'text-primary',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  reported: 'text-reported',
  neutral: 'text-muted',
};

/** Who established a result, in words: an agent's claim never reads like a verified check. */
export const evidenceLabels: Readonly<Record<EvidenceSource, string>> = {
  'controller-verified': 'verified by Grampus',
  'agent-reported': 'agent reported',
  'human-assessed': 'your assessment',
};
