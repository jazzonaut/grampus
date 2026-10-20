// Owns comparison presentation and available actions. The browser renders these decisions and sends
// their requests unchanged; the orchestration layer rechecks them against the journal.
import type { Store } from '../../persistence/store.js';
import { comparisonDecisionKey, sharedPlanDigest } from '../../domain/comparison.js';
import { runMetrics } from '../../reporting/run-metrics.js';
import { planningUsage } from '../../reporting/task-usage.js';
import { usageView } from './usage.js';
import { modelAssignments, planView } from './plan.js';
import { action } from './actions.js';

/** Full comparison read projection, with small scorecards and exact approved configurations. */
export function comparisonView(store: Store, id: string) {
  const value = store.comparison(id);
  const expected = comparisonDecisionKey(value);
  const path = `/api/comparisons/${id}`;
  const idle = !value.owner;
  const runs = value.runs.map(run => {
    const task = store.get(run.taskId);
    const matches = task.guided?.digest === run.digest && sharedPlanDigest(task.guided.plan) === value.sharedDigest;
    const metrics = runMetrics(store, run.taskId);
    return {
      ...run,
      assignments: task.guided
        ? modelAssignments(task.guided.plan).filter(assignment => assignment.role !== 'Planning')
        : [],
      metrics,
      matchesApprovedConfiguration: matches,
      preferred: value.preferredTaskId === run.taskId,
      select: action({
        id: 'comparison-select',
        label: 'Select this result',
        kind: 'secondary',
        description: 'Record a preference. Integration is a separate explicit action.',
        path: `${path}/select`,
        expected,
        body: { expected, taskId: run.taskId },
        disabledReason:
          idle && value.status === 'complete' && !value.integration && matches && metrics.verifiedDelivery
            ? null
            : 'A settled, verified comparison result is required.',
      }),
    };
  });
  return {
    apiVersion: 1 as const,
    id,
    name: value.name,
    status: value.status,
    note: value.note,
    digest: value.digest,
    expected,
    approved: value.approvedDigest === value.digest,
    cursor: value.cursor,
    plan: planView(value.plan),
    runs,
    preferredTaskId: value.preferredTaskId,
    integration: value.integration,
    sharedPlanning: value.planningSessionId ? usageView(planningUsage(store, value.planningSessionId)) : null,
    actions: [
      action({
        id: 'pause',
        label: 'Pause comparison after this step',
        kind: 'secondary',
        description: 'Let the active operation settle, then pause before further comparison work.',
        path: `${path}/pause`,
        expected,
        disabledReason: value.owner && !value.pauseRequested ? null : 'No running comparison to pause.',
      }),
      action({
        id: 'approve',
        label: 'Approve all profiles',
        kind: 'primary',
        description:
          'Approve the shared work and every displayed run configuration. No run starts until you choose Run comparison.',
        path: `${path}/approve`,
        expected,
        disabledReason: idle && value.status === 'draft' ? null : 'Comparison is already approved or owned.',
      }),
      action({
        id: 'run',
        label: 'Run comparison',
        kind: 'primary',
        description:
          'Run profiles one after another. Questions, pauses and uncertain operations wait for your decision.',
        path: `${path}/run`,
        expected,
        disabledReason:
          idle && value.approvedDigest === value.digest && ['ready', 'waiting'].includes(value.status)
            ? null
            : 'Approve the comparison and settle its current driver first.',
      }),
      action({
        id: 'recover',
        label: 'Recover comparison driver',
        kind: 'secondary',
        description: 'Release a provably dead driver without replaying any task operation.',
        path: `${path}/recover`,
        expected,
        disabledReason: value.owner ? null : 'No retained comparison driver.',
      }),
      action({
        id: 'comparison-preview',
        label: 'Inspect integration',
        kind: 'secondary',
        description: 'Inspect the current working branch before explicitly integrating the selected verified result.',
        path: `${path}/integration-preview`,
        method: 'GET',
        disabledReason: idle && value.preferredTaskId && !value.integration ? null : 'Select a preferred run first.',
      }),
      action({
        id: 'comparison-recover-integration',
        label: 'Reconcile integration',
        kind: 'secondary',
        description: "Check a dead controller's Git result without repeating its write.",
        path: `${path}/recover-integration`,
        expected,
        disabledReason:
          value.integration && value.integration.phase !== 'integrated'
            ? null
            : 'No uncertain integration to reconcile.',
      }),
    ],
    exports: { json: `${path}/export`, csv: `${path}/export?format=csv`, compressed: `${path}/export?format=gzip` },
    notes: [
      'Profiles share one plan and starting commit. Planning usage is shown once, separately.',
      'Runs are sequential; machine load, caches and subscription conditions can still vary.',
      'Choose a preferred result manually. No aggregate score establishes code quality.',
    ],
  };
}

export type ComparisonView = ReturnType<typeof comparisonView>;
