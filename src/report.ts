import { Store } from './store.js';
import { Workflow, activeSlice } from './workflow.js';

// Encode all user/provider prose, including newlines, so it cannot inject report structure.
function prose(value: string): string {
  return value.replace(/[&<>"'`*_[\]#|\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
}

export function renderReport(store: Store, id: string): string {
  const workflow = new Workflow(store);
  const task = workflow.get(id);
  const blockers = workflow.blockers(id);
  const slice = activeSlice(task);
  return [
    `# ${prose(task.brief.title)}`,
    '',
    ...(task.synthetic ? ['**Synthetic demonstration — no real agent implementation or independent review.**', ''] : []),
    `Task: ${task.id}  `,
    `State: ${task.phase}  `,
    `Requirements version: ${task.version}; approved version: ${task.approvedVersion ?? 'none'}  `,
    'Usage and billed cost: unknown (not aggregated; inspect linked session journals where available).',
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
    ...(slice ? [
      '## Slices', '',
      `Current slice: ${slice.number}/${slice.total} — ${prose(slice.title)}. Delivered: ${task.slice!.completed.length}/${slice.total}.`, '',
      ...task.brief.slices!.flatMap((item, index) => [
        `${index + 1}. ${prose(item.title)} — ${task.slice!.completed.some(done => done.index === index) ? 'delivered' : index === task.slice!.index ? 'current' : 'pending'}`,
        `   ${prose(item.plan)}`,
      ]), '',
      ...task.slice!.completed.map(done => `- Slice ${done.index + 1}: ${done.outcome}; HEAD ${done.head}; delivery ${done.deliveryId}.`), '',
      ...(slice.final ? ['Final slice verification covers every task criterion.', ''] : []),
    ] : []),
    '## Completion gates',
    '',
    ...(blockers.length ? blockers.map(reason => `- ${prose(reason)}`) : ['All recorded gates passed.']),
    '',
    '## Journal',
    '',
    ...store.events(id).flatMap(event => [
      `### ${event.sequence}. ${event.type} (v${event.version})`,
      '',
      event.at,
      '',
      // Indented code prevents arbitrary embedded backtick fences ending a block.
      ...JSON.stringify(event.data, null, 2).split('\n').map(line => `    ${line}`),
      '',
    ]),
  ].join('\n');
}
