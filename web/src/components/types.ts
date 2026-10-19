// Display shapes the shared components accept. Where a component draws a server DTO, its shape is the
// DTO itself (or the part of it the component reads), imported type-only from src/server/api-types.ts,
// so a server change that breaks a component fails the type check.
import type {
  EvidenceSource,
  ProviderUsageV1,
  StageUsageV1,
  StageView,
  UsageFieldV1,
} from '../../../src/server/api-types';
import type { StageState, Status } from '../theme/status';

export type { EvidenceSource, StageState, Status };

/** One stage of a task's workflow (`StageView`). Stages come from data because quality passes are configurable. */
export type WorkflowStage = Pick<StageView, 'id' | 'label' | 'state' | 'detail'> &
  Partial<Pick<StageView, 'evidence' | 'items'>>;

/** A measured quantity in a usage row. */
export type UsageMetric = UsageFieldV1;

/** Usage of one provider (`ProviderUsageV1`). Null values are shown as "Unknown", never as 0. */
export type ProviderUsageRow = Pick<
  ProviderUsageV1,
  | 'provider'
  | 'label'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'estimatedCostUsd'
  | 'incomplete'
  | 'sessions'
  | 'observedSessions'
>;

/** Usage of one stage on one provider (`StageUsageV1`). */
export type StageUsageRow = Pick<
  StageUsageV1,
  | 'stage'
  | 'label'
  | 'provider'
  | 'providerLabel'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'estimatedCostUsd'
  | 'incomplete'
  | 'turns'
>;
