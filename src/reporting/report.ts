import type { Store } from '../persistence/store.js';
import { Workflow, activeSlice } from '../domain/workflow.js';
import { explorationSummary } from '../repository/repository-tools.js';
import { taskUsage, usageLines } from './task-usage.js';

// Encode all user/provider prose, including newlines, so it cannot inject report structure.
function prose(value: string): string {
  return value.replace(/[&<>"'`*_[\]#|\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
}

export function renderReport(store: Store, id: string): string {
  const workflow = new Workflow(store);
  const task = workflow.get(id);
  const blockers = workflow.blockers(id);
  const slice = activeSlice(task);
  const progress = task.slice,
    briefSlices = task.brief.slices;
  const exploration = store
    .executions()
    .filter(execution => execution.taskId === id)
    .map(execution => ({
      role: execution.role,
      sessionId: execution.sessionId,
      ...explorationSummary(store.sessionEvents(execution.sessionId)),
    }))
    .filter(item => item.calls > 0);
  return [
    `# ${prose(task.brief.title)}`,
    '',
    ...(task.synthetic
      ? ['**Synthetic demonstration — no real agent implementation or independent review.**', '']
      : []),
    `Task: ${task.id}  `,
    `State: ${task.phase}  `,
    `Requirements version: ${task.version}; approved version: ${task.approvedVersion ?? 'none'}  `,
    ...usageLines(taskUsage(store, id)),
    '',
    prose(task.brief.outcome),
    '',
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
          `Current slice: ${slice.number}/${slice.total} — ${prose(slice.title)}. Delivered: ${progress.completed.length}/${slice.total}.`,
          '',
          ...briefSlices.flatMap((item, index) => [
            `${index + 1}. ${prose(item.title)} — ${progress.completed.some(done => done.index === index) ? 'delivered' : index === progress.index ? 'current' : 'pending'}`,
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
