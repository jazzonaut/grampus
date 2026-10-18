// Sample data for the component gallery (pages/DemoPage.vue). Not used against a real server.
import type { AttentionItem, SafeAction, UsageRow, WorkflowStage } from './components/types';
import type { Status } from './theme/status';

export interface MockTask {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly repository: string;
}

export const mockTasks: readonly MockTask[] = [
  { id: 'task-1', title: 'Add retry to the export job', status: 'working', repository: 'D:\\Projects\\exporter' },
  {
    id: 'task-2',
    title: 'Rename the billing settings page',
    status: 'awaiting_human',
    repository: 'D:\\Projects\\web',
  },
  { id: 'task-3', title: 'Fix date parsing in reports', status: 'complete', repository: 'D:\\Projects\\reports' },
  { id: 'task-4', title: 'Upgrade the test runner', status: 'failed', repository: 'D:\\Projects\\tooling' },
  { id: 'task-5', title: 'Document the import format', status: 'idle', repository: 'D:\\Projects\\docs' },
];

/** Stages come from data: the naming lens and refactor pass are configurable quality passes. */
export const mockStages: readonly WorkflowStage[] = [
  { id: 'preparation', label: 'Preparation', state: 'passed' },
  { id: 'implementation', label: 'Implementation', state: 'passed', detail: 'attempt 2' },
  { id: 'refactor', label: 'Refactor pass', state: 'skipped', detail: 'not selected' },
  { id: 'validation', label: 'Validation', state: 'failed', detail: '1 of 3 checks' },
  { id: 'review', label: 'Independent review', state: 'active' },
  { id: 'naming', label: 'Naming lens', state: 'unknown' },
  { id: 'acceptance', label: 'Acceptance', state: 'pending' },
  { id: 'delivery', label: 'Local commit', state: 'pending' },
];

const approveActions: readonly SafeAction[] = [
  { id: 'answer', label: 'Send answer', tone: 'primary' },
  { id: 'stop', label: 'Stop now', tone: 'neutral' },
];

export const mockAttention: readonly AttentionItem[] = [
  {
    id: 'task-2',
    title: 'Rename the billing settings page',
    why: 'The agent asked whether the old URL should redirect to the new one.',
    status: 'awaiting_human',
    decisionKey: 'v3:awaiting_answer:turn-7',
    actions: approveActions,
  },
  {
    id: 'task-4',
    title: 'Upgrade the test runner',
    why: 'Validation failed three times and the repair allowance is used up.',
    status: 'blocked',
    decisionKey: 'v1:failed:exec-42',
    actions: [
      { id: 'retry', label: 'Retry repair', tone: 'primary' },
      { id: 'revise', label: 'Revise plan', tone: 'neutral' },
      { id: 'release', label: 'Release unused reservation', disabledReason: 'The workspace still has files.' },
    ],
  },
];

export const mockDecision = {
  title: 'Approve plan version 3',
  decisionKey: 'v3:draft:digest-9f2c',
  actions: [
    { id: 'approve', label: 'Approve and run', tone: 'primary' },
    { id: 'revise', label: 'Ask for changes', tone: 'neutral' },
    { id: 'delete', label: 'Delete task', tone: 'danger' },
  ] satisfies readonly SafeAction[],
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
export const mockUsageProviders: readonly UsageRow[] = [
  {
    id: 'codex',
    label: 'Codex',
    inputTokens: 182_340,
    outputTokens: 12_904,
    cachedInputTokens: 96_000,
    estimatedCostUsd: 0.4213,
    partial: [],
    sessions: { observed: 3, total: 3 },
  },
  {
    id: 'claude',
    label: 'Claude',
    inputTokens: 54_200,
    outputTokens: null,
    cachedInputTokens: null,
    estimatedCostUsd: null,
    partial: ['inputTokens'],
    sessions: { observed: 1, total: 2 },
  },
];

export const mockUsageStages: readonly UsageRow[] = [
  {
    id: 'implementation',
    label: 'Implementation',
    inputTokens: 150_000,
    outputTokens: 11_000,
    cachedInputTokens: 90_000,
    estimatedCostUsd: 0.36,
    partial: [],
  },
  {
    id: 'review',
    label: 'Independent review',
    inputTokens: 0,
    outputTokens: null,
    cachedInputTokens: null,
    estimatedCostUsd: null,
    partial: [],
  },
];
