import { Store } from './store.js';
import { Workflow } from './workflow.js';

// Encode all user/provider prose, including newlines, so it cannot inject report structure.
function prose(value: string): string {
  return value.replace(/[&<>"'`*_[\]#|\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
}

export function renderReport(store: Store, id: string): string {
  const workflow = new Workflow(store);
  const task = workflow.get(id);
  const blockers = workflow.blockers(id);
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
