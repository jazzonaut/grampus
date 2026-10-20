// Owns workflow elapsed-time accounting from durable state transitions, independent of provider usage.
// Intervals are disjoint: nested diagnostics are already inside implementation time and are not added twice.
import { z } from 'zod';
import type { RecordEvent } from '../persistence/store.js';
import { stageSchema, statusSchema } from '../orchestration/guided/state.js';

const transition = z.object({
  stage: z.union([stageSchema, z.literal('planning')]),
  status: statusSchema,
  sliceIndex: z.number(),
  owner: z.looseObject({}).nullable(),
  pending: z.unknown().nullable(),
});

/** One workflow stage, accumulated across all slices and attempts. */
export interface WorkflowStageTiming {
  stage: string;
  elapsedMs: number;
  activeMs: number;
  waitingMs: number;
  recoveryMs: number;
  steps: number;
}

/** One durable step request, retained separately across slices, repairs and recovery. */
export interface WorkflowStepTiming {
  sequence: number;
  sliceIndex: number;
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  activeMs: number;
  waitingMs: number;
  recoveryMs: number;
}

/** Observed task elapsed time, including live intervals and explicit uncertainty. */
export interface WorkflowTiming {
  startedAt: string | null;
  completedAt: string | null;
  asOf: string;
  elapsedMs: number | null;
  activeMs: number;
  waitingMs: number;
  recoveryMs: number;
  live: boolean;
  clockAdjusted: boolean;
  stages: WorkflowStageTiming[];
  steps: WorkflowStepTiming[];
}

/**
 * Projects persisted transitions at a caller-supplied observation time. Waiting for approval, a person
 * or a runner is distinct from controller-owned work. Recovery intervals never masquerade as work.
 * A wall-clock regression is clamped and exposed; these are elapsed intervals, not CPU measurements.
 */
export function workflowTiming(events: readonly RecordEvent[], now = new Date().toISOString()): WorkflowTiming {
  const result: WorkflowTiming = {
    startedAt: null,
    completedAt: null,
    asOf: now,
    elapsedMs: null,
    activeMs: 0,
    waitingMs: 0,
    recoveryMs: 0,
    live: false,
    clockAdjusted: false,
    stages: [],
    steps: [],
  };
  let previous: { at: number; state: z.infer<typeof transition> } | null = null;
  let lastAt = 0;
  let activeStep: WorkflowStepTiming | null = null;
  const rows = new Map<string, WorkflowStageTiming>();
  const row = (stage: string) => {
    let value = rows.get(stage);
    if (!value) {
      value = { stage, elapsedMs: 0, activeMs: 0, waitingMs: 0, recoveryMs: 0, steps: 0 };
      rows.set(stage, value);
    }
    return value;
  };
  const accrue = (at: number, recoveredGap = false) => {
    if (!previous || previous.state.status === 'complete') return;
    if (at < previous.at) result.clockAdjusted = true;
    const duration = Math.max(0, at - previous.at);
    const bucket =
      recoveredGap || previous.state.status === 'recovery_required'
        ? 'recoveryMs'
        : previous.state.owner !== null && ['ready', 'running'].includes(previous.state.status)
          ? 'activeMs'
          : 'waitingMs';
    const value = row(previous.state.stage);
    value.elapsedMs += duration;
    value[bucket] += duration;
    result[bucket] += duration;
    if (activeStep) activeStep[bucket] += duration;
  };
  for (const event of events) {
    if (!event.type.startsWith('guided.')) continue;
    const parsed = transition.safeParse(event.data);
    if (!parsed.success) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    result.startedAt ??= event.at;
    const recoveryClaim =
      event.type === 'guided.controller_claimed' &&
      z.object({ recovering: z.boolean() }).safeParse(event.data).data?.recovering === true;
    accrue(at, recoveryClaim);
    if (event.type === 'guided.step_requested') {
      row(parsed.data.stage).steps++;
      activeStep = {
        sequence: event.sequence,
        sliceIndex: parsed.data.sliceIndex,
        stage: parsed.data.stage,
        startedAt: event.at,
        finishedAt: null,
        activeMs: 0,
        waitingMs: 0,
        recoveryMs: 0,
      };
      result.steps.push(activeStep);
    } else if (activeStep && parsed.data.pending === null) {
      activeStep.finishedAt = event.at;
      activeStep = null;
    }
    lastAt = Math.max(at, lastAt);
    previous = { at: lastAt, state: parsed.data };
    // A revision or retry can reopen a previously completed task; the latest state decides.
    if (parsed.data.status === 'complete') result.completedAt ??= event.at;
    else result.completedAt = null;
  }
  const at = Date.parse(now);
  if (previous && Number.isFinite(at)) accrue(at);
  result.live = previous !== null && previous.state.status !== 'complete';
  result.asOf = result.completedAt ?? now;
  result.elapsedMs = previous ? result.activeMs + result.waitingMs + result.recoveryMs : null;
  result.stages = [...rows.values()];
  return result;
}

/** Text shared by CLI and Markdown reports so non-provider work remains visible. */
export function workflowTimingLines(timing: WorkflowTiming): string[] {
  if (timing.elapsedMs === null) return ['Workflow elapsed time: unknown (no recorded controller transitions).'];
  return [
    `Workflow elapsed time: ${timing.elapsedMs} ms${timing.live ? ' (live)' : ''}; active ${timing.activeMs} ms; waiting ${timing.waitingMs} ms; recovery ${timing.recoveryMs} ms.`,
    ...timing.stages.map(
      row =>
        `${row.stage}: ${row.activeMs} ms active, ${row.waitingMs} ms waiting, ${row.recoveryMs} ms recovery; ${row.steps} steps.`,
    ),
    ...(timing.clockAdjusted ? ['Clock adjustment observed; elapsed intervals are clamped lower bounds.'] : []),
  ];
}
