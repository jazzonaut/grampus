// Owns the pure data contracts for fixed model profiles, run metrics and shared-plan comparisons.
// Type-only imports keep the dashboard independent of Node and controller implementation modules.
import type { ProviderId, UsageCounters, UsageV1, InterventionsV1, ActionView, PlanView } from './api-types.js';

/** Fixed reasoning settings understood by the provider adapters. */
export type ReasoningEffortV1 = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelAssignmentV1 {
  provider: ProviderId;
  model: string | null;
  effort?: ReasoningEffortV1;
}
export interface ModelProfileV1 {
  id: string;
  name: string;
  planning: ModelAssignmentV1;
  implementation: ModelAssignmentV1;
  review: ModelAssignmentV1;
  repair?: ModelAssignmentV1;
  arbitration?: ModelAssignmentV1;
  qualityPasses?: Record<string, ModelAssignmentV1>;
}
export interface ModelProfilesV1 {
  profiles: readonly ModelProfileV1[];
  expected: string | null;
  editable: boolean;
  problem: string | null;
  qualityPasses: { id: string; title: string }[];
  efforts: { codex: string[]; claude: string[] };
}

/** Display-only model suggestions discovered from the local agents, independently per provider. */
export interface ProviderModelsV1 {
  codex: ProviderModelListV1;
  claude: ProviderModelListV1;
}

/** An unavailable catalogue leaves manual model selection usable. Null efforts means unspecified. */
export interface ProviderModelListV1 {
  models: { id: string; label: string; efforts: string[] | null }[];
  problem: string | null;
}
export interface ModelMetricsV1 extends UsageCounters {
  provider: string;
  stage: string;
  model: string | null;
  requestedModel: string | null;
  effort: string | null;
  turns: number;
  wallMs: number | null;
}
export interface RunMetricsV1 {
  taskId: string;
  title: string;
  status: string;
  verifiedDelivery: boolean;
  profile: ModelProfileV1 | null;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  agentMs: number | null;
  agentTimePartial: boolean;
  checkMs: number | null;
  checkTimePartial: boolean;
  workflowActiveMs: number | null;
  waitingMs: number | null;
  timingAsOf: string | null;
  timingPartial: boolean;
  firstAttemptDelivery: boolean | null;
  repairAttempts: number;
  interventions: InterventionsV1;
  usage: UsageV1;
  models: ModelMetricsV1[];
  subscriptionAllowanceConsumed: null;
  billedCostUsd: null;
  subscription: { observations: number; rejectedTurns: number | null; allowanceConsumed: null };
  notes: string[];
}
export interface ComparisonSummaryV1 {
  id: string;
  name: string;
  status: string;
}
export interface ComparisonV1 {
  apiVersion: 1;
  id: string;
  name: string;
  status: string;
  note: string;
  digest: string;
  expected: string;
  approved: boolean;
  cursor: number;
  plan: PlanView;
  runs: {
    taskId: string;
    version: number;
    digest: string;
    profile: ModelProfileV1;
    metrics: RunMetricsV1;
    assignments: NonNullable<PlanView['modelAssignments']>;
    matchesApprovedConfiguration: boolean;
    preferred: boolean;
    select: ActionView;
  }[];
  preferredTaskId: string | null;
  integration: {
    taskId: string;
    repository: string;
    branch: string;
    base: string;
    commit: string;
    phase: 'requested' | 'integrated' | 'recovery_required';
    error: string | null;
  } | null;
  sharedPlanning: UsageV1 | null;
  actions: ActionView[];
  exports: { json: string; csv: string; compressed: string };
  notes: string[];
}
export interface IntegrationPreviewV1 {
  target: { repository: string; branch: string; base: string; commit: string };
  action: ActionView;
}
