// Display shapes the shared components accept. Where a component draws a server DTO, its shape is the
// DTO itself (or the part of it the component reads), imported type-only from src/server/api-types.ts,
// so a server change that breaks a component fails the type check.
import type {
  ActionKind,
  ActionView,
  AttentionItem as AttentionItemV1,
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

/** Visual weight of an action button (`ActionView.kind`). `danger` is for actions that discard or hide work. */
export type ActionTone = ActionKind;

/**
 * An action the user can safely take from where they are: the part of `ActionView` a button needs.
 * `expected` is the decision key it was offered for; the page sends it back unchanged.
 */
export type SafeAction = Pick<ActionView, 'id' | 'label' | 'kind' | 'expected' | 'disabledReason'>;

/** Something that needs the user (`AttentionItem` from the overview), with the actions that resolve it. */
export type AttentionItem = Pick<AttentionItemV1, 'id' | 'kind' | 'title' | 'why' | 'status'> & {
  readonly actions: readonly SafeAction[];
};

/** Emitted when the user picks an action: which item, which action and the decision key it carries. */
export interface ActionChoice {
  readonly itemId: string;
  readonly actionId: string;
  readonly expected: string | null;
}

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

/** One page of a log, as the server returns it. */
export interface LogPage {
  readonly text: string;
  /** Offset to request the next page from, or null at the end. */
  readonly nextOffset: number | null;
}
