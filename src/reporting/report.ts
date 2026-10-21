// Owns the Markdown task report: brief, slices, usage, completion gates, exploration and the full
// journal, rendered from stored records only. It reads and never changes state, and it treats every
// piece of user or provider text as data that must not shape the document.
import type { Store } from '../persistence/store.js';
import { Workflow, activeSlice } from '../domain/workflow.js';
import { explorationSummary } from '../repository/repository-tools.js';
import { taskUsage, usageLines, usageTable } from './task-usage.js';
import { workflowTimingLines } from './workflow-timing.js';
import { spendingLines, spendingStatus } from '../orchestration/guided/spending.js';
import { executionPhases } from './execution-phases.js';

// Encode all user/provider prose, including newlines, so it cannot inject report structure.
function prose(value: string): string {
  return value.replace(/[&<>"'`*_[\]#|\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
}

function phaseLines(store: Store, taskId: string): string[] {
  const rows = executionPhases(store, taskId);
  if (!rows.length) return [];
  return [
    '## Execution phases',
    '',
    'Observed phase totals overlap and must not be added to workflow elapsed time.',
    '',
    ...rows.map(
      row =>
        `- ${prose(row.phase)}: ${row.elapsedMs.toFixed(1)} ms across ${row.observations} observations; ${row.failed} failed operations.`,
    ),
    '',
  ];
}

/**
 * The Markdown report of task `id`. Gates come from {@link Workflow.blockers}, so the report shows the
 * controller's own verdict rather than any agent's account. Throws as `Store.get` does when the task is
 * missing or malformed.
 */
export function renderReport(store: Store, id: string): string {
  const workflow = new Workflow(store);
  const task = workflow.get(id);
  const blockers = workflow.blockers(id);
  const slice = activeSlice(task);
  const progress = task.slice,
    briefSlices = task.brief.slices;
  const usage = taskUsage(store, id);
  const exploration = store
    .executions(id)
    .map(execution => ({
      role: execution.role,
      sessionId: execution.sessionId,
      ...explorationSummary(store.sessionEvents(execution.sessionId)),
    }))
    .filter(item => item.calls > 0);
  return [
    `# ${prose(task.brief.title)}`,
    '',
    ...(task.synthetic ? ['**Synthetic demonstration: no real agent implementation or independent review.**', ''] : []),
    `Task: ${task.id}  `,
    `State: ${task.phase}  `,
    `Requirements version: ${task.version}; approved version: ${task.approvedVersion ?? 'none'}  `,
    // Provider totals, turns and interventions only; the per-stage lines are the table further down.
    ...usageLines(usage).slice(0, usage.providers.length + 2),
    ...(task.guided ? spendingLines(spendingStatus(usage, task.guided.plan.workflowPolicy)) : []),
    '',
    prose(task.brief.outcome),
    '',
    ...(usage.workflow ? ['## Workflow timing', '', ...workflowTimingLines(usage.workflow), ''] : []),
    ...phaseLines(store, id),
    '## Acceptance criteria',
    '',
    ...task.brief.criteria.map(criterion => `- ${prose(criterion)}`),
    '',
    '## Plan',
    '',
    prose(task.brief.plan),
    '',
    ...(task.guided?.plan.references?.length
      ? [
          '## Read-only reference folders',
          '',
          ...task.guided.plan.references.map(
            (reference, index) =>
              `- reference-${index + 1}: ${prose(reference.path)}; source ${reference.base ?? reference.digest}; ${reference.totalFiles} files.`,
          ),
          '',
        ]
      : []),
    ...(slice && progress && briefSlices
      ? [
          '## Slices',
          '',
          `Current slice: ${slice.number}/${slice.total} - ${prose(slice.title)}. Delivered: ${progress.completed.length}/${slice.total}.`,
          '',
          ...briefSlices.flatMap((item, index) => [
            `${index + 1}. ${prose(item.title)} (${progress.completed.some(done => done.index === index) ? 'delivered' : index === progress.index ? 'current' : 'pending'})`,
            `   ${prose(item.plan)}`,
          ]),
          '',
          ...progress.completed.map(
            done => `- Slice ${done.index + 1}: ${done.outcome}; HEAD ${done.head}; delivery ${done.deliveryId}.`,
          ),
          '',
          ...(slice.final ? ['Final slice verification covers every task criterion.', ''] : []),
        ]
      : []),
    ...(usage.stages.length
      ? [
          '## Usage by stage',
          '',
          ...usageTable(usage),
          '',
          'Turns attribute to the stage recorded when they were requested. Unknown values are never counted as zero; partial values are lower bounds. Wall time is from turn request to recorded result.',
          '',
        ]
      : []),
    '## Completion gates',
    '',
    ...(blockers.length ? blockers.map(reason => `- ${prose(reason)}`) : ['All recorded gates passed.']),
    '',
    ...(exploration.length
      ? [
          '## Repository exploration',
          '',
          ...exploration.flatMap(item => [
            `- ${item.role}: ${item.calls} completed list/search/read calls. Session: ${item.sessionId}.`,
            ...item.readFiles.map(path => `  - Read: ${prose(path)}`),
          ]),
          '',
          'Exact bounded results, source identities and read hashes are retained in each session journal. File reads do not establish runtime validation or whole-repository review.',
          '',
        ]
      : []),
    '## Journal',
    '',
    ...store.events(id).flatMap(event => [
      `### ${event.sequence}. ${event.type} (v${event.version})`,
      '',
      event.at,
      '',
      // Indented code prevents arbitrary embedded backtick fences ending a block.
      ...JSON.stringify(event.data, null, 2)
        .split('\n')
        .map(line => `    ${line}`),
      '',
    ]),
  ].join('\n');
}
