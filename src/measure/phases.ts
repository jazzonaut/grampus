// Phase accounting separates useful implementation from setup, verification and workflow interventions.
import type { StoredEvent, Stage } from '../domain/events.js';
import type { ScoredDispatch } from './report.js';

export type Phase =
  'setup' | 'specification' | 'tests' | 'implementation' | 'repair' | 'polish' | 'verification' | 'explanation';
export interface PhaseMeasurement {
  phase: Phase;
  agentMs: number | null;
  unknownTime: number;
  checkMs: number;
  costUsd: number | null;
  unknownCost: number;
}

const stagePhase: Record<Stage, Phase> = {
  spec: 'specification',
  'spec-review': 'specification',
  tests: 'tests',
  build: 'implementation',
  repair: 'repair',
  review: 'verification',
  polish: 'polish',
  'polish-review': 'polish',
  explain: 'explanation',
  answer: 'explanation',
};

/** Sum recorded work, not elapsed wall time: concurrent workers and checks can overlap. */
export function measurePhases(
  events: readonly StoredEvent[],
  dispatches: readonly ScoredDispatch[],
): PhaseMeasurement[] {
  const phases: Phase[] = [
    'setup',
    'specification',
    'tests',
    'implementation',
    'repair',
    'polish',
    'verification',
    'explanation',
  ];
  return phases.map(phase => {
    const workers = dispatches.filter(item => stagePhase[item.stage] === phase);
    const knownTime = workers.filter(item => item.agentMs !== null);
    const knownCost = workers.filter(item => item.costUsd !== null);
    let checkMs = 0;
    const counted = new Set<string>();
    for (const event of events) {
      if (event.type === 'setup.recorded' && phase === 'setup') checkMs += event.result.durationMs;
      if (event.type === 'checks.recorded' && phase === 'verification')
        for (const result of event.results) {
          // The baseline may reuse the spec check's immutable log rather than execute again.
          if (!counted.has(result.logPath)) checkMs += result.durationMs;
          counted.add(result.logPath);
        }
      if (event.type === 'polish.checked' && phase === 'polish')
        checkMs += event.results.reduce((sum, result) => sum + result.durationMs, 0);
    }
    return {
      phase,
      agentMs: !workers.length
        ? 0
        : knownTime.length
          ? knownTime.reduce((sum, worker) => sum + (worker.agentMs ?? 0), 0)
          : null,
      unknownTime: workers.length - knownTime.length,
      checkMs,
      costUsd: !workers.length
        ? 0
        : knownCost.length
          ? knownCost.reduce((sum, worker) => sum + (worker.costUsd ?? 0), 0)
          : null,
      unknownCost: workers.length - knownCost.length,
    };
  });
}

/** Attribute corrections only from explicit user labels or an unambiguous workflow failure gate. */
export function interventionCounts(
  events: readonly StoredEvent[],
): Record<'implementation' | 'workflow' | 'unknown', number> {
  const counts = { implementation: 0, workflow: 0, unknown: 0 };
  let reason = '';
  for (const event of events) {
    if (event.type === 'attention.needed') reason = event.reason;
    if (event.type === 'attention.withdrawn') reason = '';
    if (event.type !== 'command.applied') continue;
    if (['continue', 'revise', 'retry', 'reply'].includes(event.command.kind)) {
      const purpose =
        event.command.purpose ??
        (/^(setup-failed|stage-failed|stage-quiet|tests-failed)/.test(reason) ? 'workflow' : 'unknown');
      counts[purpose]++;
    }
    if (event.command.kind !== 'reply') reason = '';
  }
  return counts;
}
