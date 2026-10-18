// Display shapes the shared components accept. They describe what is drawn, not the server's
// records: a later step maps the typed view-model API onto them.
import type { StageState, Status } from '../theme/status';

export type { StageState, Status };

/** One stage of a task's workflow. Stages come from data because quality passes are configurable. */
export interface WorkflowStage {
  readonly id: string;
  readonly label: string;
  readonly state: StageState;
  /** Short extra context, e.g. "attempt 2 of 3". */
  readonly detail?: string;
}

/** Visual weight of an action button. `danger` is for actions that discard or hide work. */
export type ActionTone = 'primary' | 'neutral' | 'danger';

/** An action the user can safely take from where they are. */
export interface SafeAction {
  readonly id: string;
  readonly label: string;
  readonly tone?: ActionTone;
  /** Why the action is unavailable; set to disable it and explain. */
  readonly disabledReason?: string;
}

/** Something that needs the user, with the reason and the actions that resolve it. */
export interface AttentionItem {
  readonly id: string;
  readonly title: string;
  /** Plain-language reason this needs a person. */
  readonly why: string;
  readonly status: Status;
  /** The decision key displayed with this item; actions send it back as `expected`. */
  readonly decisionKey: string;
  readonly actions: readonly SafeAction[];
}

/** Emitted when the user picks an action. */
export interface ActionChoice {
  readonly itemId: string;
  readonly actionId: string;
  readonly decisionKey: string;
}

/** A measured quantity in a usage row. */
export type UsageMetric = 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'estimatedCostUsd';

/**
 * Token and cost measurements for one provider or stage. `null` means not measured and is
 * shown as "Unknown", never as 0.
 */
export interface UsageRow {
  readonly id: string;
  readonly label: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  /** Estimated cost in US dollars from provider rates. Never a billed amount. */
  readonly estimatedCostUsd: number | null;
  /** Metrics whose value is a lower bound because some observations are missing. */
  readonly partial: readonly UsageMetric[];
  /** How many sessions reported usage, when known. */
  readonly sessions?: { readonly observed: number; readonly total: number };
}

/** One page of a log, as the server returns it. */
export interface LogPage {
  readonly text: string;
  /** Offset to request the next page from, or null at the end. */
  readonly nextOffset: number | null;
}
