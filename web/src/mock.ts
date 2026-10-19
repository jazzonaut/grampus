// Sample data for the component gallery (pages/DemoPage.vue). Not used against a real server. Every
// value has the server's v1 type (src/server/api-types.ts), so the gallery cannot drift from the API.
import type {
  ActionView,
  AttentionItem,
  ProviderUsageV1,
  StageUsageV1,
  StageView,
  TaskSummaryV1,
  UsageHeadlineV1,
} from '../../src/server/api-types';

const headline: UsageHeadlineV1 = {
  tokens: null,
  estimatedCostUsd: null,
  completeness: 'none',
  turns: 0,
  interventions: 0,
};

function task(
  id: string,
  title: string,
  look: Pick<TaskSummaryV1, 'status' | 'statusLabel'>,
  repository: string,
): TaskSummaryV1 {
  return {
    id,
    title,
    repository: { name: repository, path: `D:\\Projects\\${repository}` },
    ...look,
    stageLabel: 'Implement',
    slice: { index: 1, count: 1 },
    implementer: { id: 'codex', label: 'Codex', model: null },
    reviewer: { id: 'claude', label: 'Claude', model: null },
    lastActivityAt: '2026-10-19T09:00:00.000Z',
    stalled: null,
    usage: headline,
    needsAttention: ['awaiting_human', 'failed', 'blocked'].includes(look.status),
  };
}

export const mockTasks: readonly TaskSummaryV1[] = [
  task('task-1', 'Add retry to the export job', { status: 'working', statusLabel: 'Working' }, 'exporter'),
  task(
    'task-2',
    'Rename the billing settings page',
    { status: 'awaiting_human', statusLabel: 'Your answer is needed' },
    'web',
  ),
  task('task-3', 'Fix date parsing in reports', { status: 'complete', statusLabel: 'Delivered locally' }, 'reports'),
  task('task-4', 'Upgrade the test runner', { status: 'failed', statusLabel: 'Repair allowance used up' }, 'tooling'),
  task('task-5', 'Document the import format', { status: 'idle', statusLabel: 'Ready to continue' }, 'docs'),
];

/** Stages come from data: the refactor pass and naming lens are configurable quality passes. */
export const mockStages: readonly StageView[] = [
  { id: 'plan', kind: 'plan', label: 'Plan', state: 'passed', evidence: null, detail: 'Version 3 approved', items: [] },
  {
    id: 'implement',
    kind: 'implement',
    label: 'Implement',
    state: 'passed',
    evidence: 'agent-reported',
    detail: '1 repair',
    items: [],
  },
  {
    id: 'quality:refactor',
    kind: 'quality_pass',
    label: 'Refactor pass',
    state: 'passed',
    evidence: 'agent-reported',
    detail: 'No changes needed',
    items: [],
  },
  {
    id: 'validate',
    kind: 'validate',
    label: 'Validate',
    state: 'passed',
    evidence: 'controller-verified',
    detail: 'Tests',
    items: [],
  },
  {
    id: 'review',
    kind: 'review',
    label: 'Review',
    state: 'active',
    evidence: null,
    detail: null,
    items: [{ id: 'lens:naming', label: 'Naming lens', state: 'pending', evidence: null, detail: null }],
  },
  { id: 'accept', kind: 'accept', label: 'Accept', state: 'pending', evidence: null, detail: null, items: [] },
  { id: 'deliver', kind: 'deliver', label: 'Deliver', state: 'unknown', evidence: null, detail: null, items: [] },
];

function action(id: ActionView['id'], label: string, kind: ActionView['kind'], expected: string): ActionView {
  return {
    id,
    label,
    kind,
    description: `${label} (demo).`,
    expected,
    confirm: null,
    form: null,
    enabled: true,
    disabledReason: null,
    request: { method: 'POST', path: `/api/tasks/demo/${id}`, body: { expected } },
  };
}

export const mockAttention: readonly AttentionItem[] = [
  {
    id: 'task:task-2:question',
    kind: 'question',
    taskId: 'task-2',
    kickoffId: null,
    title: 'Rename the billing settings page',
    why: 'The agent asked whether the old URL should redirect to the new one.',
    status: 'awaiting_human',
    stopReason: 'AGENT_QUESTION',
    since: '2026-10-19T08:55:00.000Z',
    actions: [action('answer', 'Send answers and continue', 'primary', 'v3:awaiting_answer:turn-7')],
  },
  {
    id: 'task:task-4:failed_check',
    kind: 'failed_check',
    taskId: 'task-4',
    kickoffId: null,
    title: 'Upgrade the test runner',
    why: "The check still fails and this slice's check repair allowance is used up.",
    status: 'failed',
    stopReason: 'CHECK_REPAIR_EXHAUSTED',
    since: '2026-10-19T08:40:00.000Z',
    actions: [
      action('retry', 'Retry repair', 'primary', 'v1:blocked:exec-42'),
      {
        ...action('release-workspace', 'Release unused reservation', 'secondary', 'v1:blocked:exec-42'),
        enabled: false,
        disabledReason: 'The workspace still has files.',
      },
    ],
  },
];

export const mockDecision = {
  title: 'Approve plan version 3',
  actions: [
    action('approve', 'Approve and start', 'primary', 'v3:draft:digest-9f2c'),
    action('revise', "Revise this task's plan", 'secondary', 'v3:draft:digest-9f2c'),
    action('delete', 'Delete task', 'danger', 'v3:draft:digest-9f2c'),
  ] satisfies readonly ActionView[],
} as const;

export const mockPlanMarkdown = `**Outcome:** the export job retries transient network failures up to three times.

- Wrap \`sendBatch\` in a bounded retry with jittered back-off.
- Add a test that fails twice, then succeeds.

<script>alert('raw HTML is escaped, never run')</script>

[Retry guidance](https://example.org/retries) · [unsafe link](javascript:alert(1))`;

export const mockLogPages: readonly string[] = [
  Array.from({ length: 40 }, (_, line) => `> npm test  [line ${line + 1}]  ok ${line + 1} - exporter`).join('\n'),
  Array.from({ length: 20 }, (_, line) => `not ok ${line + 41} - retries a transient failure`).join('\n'),
];

/** Mixed known, unknown (null) and partial values, to show that unknown is never 0. */
export const mockUsageProviders: readonly ProviderUsageV1[] = [
  {
    provider: 'codex',
    label: 'Codex',
    inputTokens: 182_340,
    outputTokens: 12_904,
    cachedInputTokens: 96_000,
    cacheWriteInputTokens: 0,
    estimatedCostUsd: null,
    incomplete: [],
    sessions: 3,
    observedSessions: 3,
    activeSessions: 0,
    updatedAt: '2026-10-19T09:00:00.000Z',
    completeness: 'complete',
    billedCostUsd: null,
  },
  {
    provider: 'claude',
    label: 'Claude',
    inputTokens: 54_200,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostUsd: 0.4213,
    incomplete: ['inputTokens', 'estimatedCostUsd'],
    sessions: 2,
    observedSessions: 1,
    activeSessions: 0,
    updatedAt: '2026-10-19T09:00:00.000Z',
    completeness: 'partial',
    billedCostUsd: null,
  },
];

export const mockUsageStages: readonly StageUsageV1[] = [
  {
    stage: 'implementation',
    label: 'Implementation',
    provider: 'codex',
    providerLabel: 'Codex',
    turns: 2,
    failedTurns: 0,
    interruptedTurns: 0,
    unsettledTurns: 0,
    wallMs: 95_000,
    wallPartial: false,
    inputTokens: 150_000,
    outputTokens: 11_000,
    cachedInputTokens: 90_000,
    cacheWriteInputTokens: 0,
    estimatedCostUsd: null,
    incomplete: [],
  },
  {
    stage: 'review',
    label: 'Review',
    provider: 'claude',
    providerLabel: 'Claude',
    turns: 1,
    failedTurns: 0,
    interruptedTurns: 0,
    unsettledTurns: 1,
    wallMs: null,
    wallPartial: true,
    inputTokens: 0,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostUsd: null,
    incomplete: [],
  },
];
