// Owns the contract between the guided controller and its stage handlers: the typed context a
// handler receives, the outcome it returns, and the helpers every handler uses to adopt a result.
import type { Store } from '../../persistence/store.js';
import type { Workflow } from '../../domain/workflow.js';
import type { Workspaces } from '../../repository/workspaces.js';
import type { Executions } from '../../execution/executions.js';
import type { ExecutionLease } from '../../execution/execution-state.js';
import type { Checks } from '../../verification/checks.js';
import type { RepositorySnapshot } from '../../repository/artifacts.js';
import type { GuidedServices, GuidedState, Pending, Stage, WaitStatus } from './state.js';
import { GuidedStopError, type StopReasonCode } from './stop-reasons.js';

/** A mutation of the guided state, applied inside the controller's journaled transaction. */
export type StateUpdate = (state: GuidedState) => void;

/** Collaborators and journaled effects available to every handler while it owns the runner. */
export interface GuidedContext {
  readonly id: string;
  /** The runner ownership token; every journaled change is fenced on it. */
  readonly token: string;
  readonly store: Store;
  readonly services: GuidedServices;
  readonly workflow: Workflow;
  readonly workspaces: Workspaces;
  readonly executions: Executions;
  readonly checks: Checks;
  /** Saves `update` and journals `type` in one transaction; returns the saved state. */
  readonly change: (type: string, update: StateUpdate) => GuidedState;
  /** Closes the attempt's executions and returns to execution with feedback for the next attempt. */
  readonly prepareRetry: (type: string, explicitSnapshot?: RepositorySnapshot) => void;
}

/** What a handler sees when dispatching its step. */
export interface PerformContext extends GuidedContext {
  /** The state after the step intent was journaled. */
  readonly state: GuidedState;
  readonly signal: AbortSignal;
}

/** What a handler sees when settling its step. */
export interface SettleContext extends GuidedContext {
  /** The state when settlement started; intermediate changes do not update it. */
  readonly state: GuidedState;
  readonly pending: Pending;
  /** The snapshot returned by `perform`, for steps that produce no durable record of their own. */
  readonly snapshot: RepositorySnapshot | null;
  /** Explicit recovery is settling a step a previous controller left pending. */
  readonly recovering: boolean;
}

/** A stop reason as a handler states it; the controller timestamps it. */
export interface StopInput {
  code: StopReasonCode;
  /** The human-readable note recorded on the task. */
  note: string;
}

/**
 * How a settled step moves the task. The controller applies the outcome in one journaled change;
 * `rerouted` means the handler already sent the task back atomically (repair or arbitration),
 * because those moves need several journal events in a fixed order.
 */
export type StageOutcome =
  | { kind: 'advance'; next: Stage; update?: StateUpdate }
  | { kind: 'wait'; next: Stage; status: WaitStatus; reason: StopInput; update?: StateUpdate }
  | { kind: 'stop'; reason: StopInput }
  | { kind: 'missing' }
  | { kind: 'rerouted'; to: 'repair' | 'arbitration' };

/** One guided step: what it dispatches and how it adopts the result. */
export interface StageHandler {
  /** Result ids that already exist, so settlement can tell this step's new result apart. */
  readonly known: (context: GuidedContext, state: GuidedState) => string[];
  /** Dispatches the step's leaf operation. Only `scope` returns a snapshot; it has no durable record. */
  readonly perform: (context: PerformContext) => Promise<RepositorySnapshot | null>;
  /** Adopts the step's result, or explains why the task must stop. */
  readonly settle: (context: SettleContext) => StageOutcome;
}

/** Task evidence ids; stages without a leaf record of their own detect new results through them. */
export function evidenceIds({ workflow, id }: GuidedContext): string[] {
  return workflow.get(id).evidence.map(item => item.id);
}

/**
 * The single result created since the step intent. Two new results mean something else acted on
 * this task, so nothing is adopted and nothing is replayed.
 */
export function adoptOne<T extends { id: string }>(items: T[], pending: Pending): T | null {
  const found = items.filter(item => !pending.known.includes(item.id));
  if (found.length > 1)
    throw new GuidedStopError(
      'RESULT_AMBIGUOUS',
      'Ambiguous step results; inspect the ordinary CLI. No operation will be replayed.',
    );
  return found[0] ?? null;
}

/**
 * Proves a result was produced under this step's controller: its lease must name the same process
 * identity and host as the journaled intent. A result from another controller is never adopted.
 */
export function requireOrigin(context: GuidedContext, executionId: string, runId: string, pending: Pending): void {
  const event = context.store
    .executionEvents(executionId)
    .find(event => event.type === 'lease.acquired' && (event.data as ExecutionLease).runId === runId);
  const lease = event?.data as ExecutionLease | undefined;
  if (
    !lease ||
    lease.controllerPid !== pending.controller.controllerPid ||
    lease.controllerStartedAt !== pending.controller.controllerStartedAt ||
    lease.host !== pending.controller.host
  )
    throw new GuidedStopError(
      'RESULT_FOREIGN',
      'Step result belongs to a different controller; inspect it through the ordinary CLI',
    );
}

/** Refuses a result whose leaf operation is still running or itself needs recovery. */
export function requireSettled(result: { id: string; phase: string }, label: string): void {
  if (result.phase === 'running' || result.phase === 'recovery_required')
    throw new GuidedStopError('OPERATION_NEEDS_RECOVERY', `${label} needs recovery: ${result.id}`);
}

/** A result that differs from the journaled request; the message names what differs. */
export function mismatch(message: string): GuidedStopError {
  return new GuidedStopError('RESULT_MISMATCH', message);
}
