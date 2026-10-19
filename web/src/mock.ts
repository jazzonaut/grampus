// Typed sample DTOs for component and screen tests. Every value has the server's v1 type
// (src/server/api-types.ts), so a server change that breaks a screen also breaks these fixtures. The
// action forms follow `server/view-model/actions.ts`: the same field kinds, JSON pointer targets and bodies.
import type {
  ActionView,
  AttentionItem,
  FormField,
  KickoffDetailV1,
  OverviewV1,
  PlanView,
  ProviderUsageV1,
  StageUsageV1,
  StageView,
  TaskDetailV1,
  TaskSummaryV1,
  UsageHeadlineV1,
  UsageV1,
} from '../../src/server/api-types';

const unmeasured: UsageHeadlineV1 = {
  tokens: null,
  estimatedCostUsd: null,
  completeness: 'none',
  turns: 0,
  interventions: 0,
};

function field(spec: Partial<FormField> & Pick<FormField, 'name' | 'label' | 'input' | 'target'>): FormField {
  return {
    value: null,
    required: false,
    help: null,
    suggestions: [],
    options: [],
    min: null,
    max: null,
    step: null,
    placeholder: null,
    ...spec,
  };
}

/** An action as the server builds it: body `{ expected }` unless given. */
export function mockAction(
  id: ActionView['id'],
  label: string,
  spec: Partial<ActionView> & { path: string; body?: ActionView['request']['body'] },
): ActionView {
  const expected = spec.expected === undefined ? 'key-1' : spec.expected;
  return {
    id,
    label,
    kind: spec.kind ?? 'secondary',
    description: spec.description ?? `${label}.`,
    expected,
    confirm: spec.confirm ?? null,
    form: spec.form ?? null,
    enabled: spec.enabled ?? true,
    disabledReason: spec.disabledReason ?? null,
    request: {
      method: spec.request?.method ?? 'POST',
      path: spec.path,
      body: spec.body === undefined ? (expected === null ? {} : { expected }) : spec.body,
    },
  };
}

function summary(id: string, title: string, look: Pick<TaskSummaryV1, 'status' | 'statusLabel'>): TaskSummaryV1 {
  return {
    id,
    title,
    repository: { name: 'exporter', path: 'D:\\Projects\\exporter' },
    ...look,
    stageLabel: 'Implement',
    slice: { index: 1, count: 2 },
    implementer: { id: 'codex', label: 'Codex', model: null },
    reviewer: { id: 'claude', label: 'Claude', model: null },
    lastActivityAt: '2026-10-19T09:00:00.000Z',
    stalled: null,
    usage: unmeasured,
    needsAttention: look.status === 'awaiting_human',
  };
}

export const mockQuestionAttention: AttentionItem = {
  id: 'task:task-2:question',
  kind: 'question',
  taskId: 'task-2',
  kickoffId: null,
  title: 'Rename the billing settings page',
  why: 'The agent asked whether the old URL should redirect to the new one.',
  status: 'awaiting_human',
  stopReason: 'AGENT_QUESTION',
  since: '2026-10-19T08:55:00.000Z',
  actions: [
    mockAction('answer', 'Send answers and continue', {
      kind: 'primary',
      path: '/api/tasks/task-2/answer',
      form: { kind: 'answers', intro: null, fields: [], submitLabel: 'Send answers and continue' },
    }),
  ],
};

export const mockRetryAttention: AttentionItem = {
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
    mockAction('retry', 'Retry repair', { kind: 'primary', path: '/api/tasks/task-4/retry', expected: 'key-4' }),
  ],
};

export const mockOverview: OverviewV1 = {
  apiVersion: 1,
  revision: 'r1',
  application: {
    name: 'Grampus',
    version: '0.1.0',
    channel: 'development',
    build: null,
    journal: 'C:\\data\\grampus.sqlite',
  },
  health: {
    overall: 'degraded',
    label: 'Integrations need attention',
    reason: 'Claude sign-in is not available.',
    checkedAt: '2026-10-19T08:00:00.000Z',
    stale: false,
    warnings: [
      'Codex changed from 0.162.0 to 0.163.0 since the last successful delivery; capabilities are untested on this version',
    ],
    integrations: [
      {
        id: 'codex',
        label: 'Codex',
        required: true,
        status: 'healthy',
        statusLabel: 'Healthy',
        version: '0.163.0',
        sdkVersion: null,
        capabilities: [
          { name: 'handshake', label: 'Handshake', status: 'healthy', statusLabel: 'Healthy', detail: '' },
          {
            name: 'inference',
            label: 'Inference',
            status: 'untested',
            statusLabel: 'Not tested',
            detail: 'Health checks never send a turn',
          },
        ],
      },
      {
        id: 'claude',
        label: 'Claude',
        required: true,
        status: 'auth_unavailable',
        statusLabel: 'Sign-in needed',
        version: '2.1.0',
        sdkVersion: '0.3.302',
        capabilities: [
          {
            name: 'auth',
            label: 'Sign-in',
            status: 'auth_unavailable',
            statusLabel: 'Sign-in needed',
            detail: 'Run claude login',
          },
        ],
      },
    ],
  },
  pool: { running: 1, limit: 2 },
  attention: [mockRetryAttention, mockQuestionAttention],
  tasks: [
    summary('task-1', 'Add retry to the export job', { status: 'working', statusLabel: 'Working' }),
    summary('task-2', 'Rename the billing settings page', {
      status: 'awaiting_human',
      statusLabel: 'Your answer is needed',
    }),
  ],
  planning: [
    {
      id: 'kickoff-1',
      title: 'Document the import format',
      repository: { name: 'docs', path: 'D:\\Projects\\docs' },
      status: 'idle',
      statusLabel: 'Plan proposed',
      provider: { id: 'claude', label: 'Claude', model: null },
      lastActivityAt: null,
      needsAttention: false,
    },
  ],
  recentDeliveries: [
    {
      taskId: 'task-3',
      taskTitle: 'Fix date parsing in reports',
      slice: { index: 1, count: 1 },
      commit: '0123456789abcdef0123456789abcdef01234567',
      outcome: 'committed',
      deliveredAt: '2026-10-18T17:00:00.000Z',
      evidence: 'Validation and acceptance verified by Grampus; independent review by Claude',
    },
  ],
  qualityPasses: [{ id: 'simplification', title: 'Simplification', kind: 'lens' }],
};

export const emptyOverview: OverviewV1 = {
  ...mockOverview,
  health: {
    ...mockOverview.health,
    overall: 'unknown',
    label: 'Integrations not checked yet',
    reason: 'No check has run.',
    checkedAt: null,
    warnings: [],
    integrations: [],
  },
  pool: { running: 0, limit: 2 },
  attention: [],
  tasks: [],
  planning: [],
  recentDeliveries: [],
};

export const mockStages: readonly StageView[] = [
  { id: 'plan', kind: 'plan', label: 'Plan', state: 'passed', evidence: null, detail: 'Version 3 approved', items: [] },
  {
    id: 'implement',
    kind: 'implement',
    label: 'Implement',
    state: 'passed',
    evidence: 'agent-reported',
    detail: null,
    items: [],
  },
  {
    id: 'validate',
    kind: 'validate',
    label: 'Validate',
    state: 'failed',
    evidence: 'controller-verified',
    detail: 'Tests',
    items: [],
  },
  {
    id: 'review',
    kind: 'review',
    label: 'Review',
    state: 'pending',
    evidence: null,
    detail: null,
    items: [{ id: 'lens:simplification', label: 'Simplification', state: 'pending', evidence: null, detail: null }],
  },
  { id: 'accept', kind: 'accept', label: 'Accept', state: 'pending', evidence: null, detail: null, items: [] },
  { id: 'deliver', kind: 'deliver', label: 'Deliver', state: 'unknown', evidence: null, detail: null, items: [] },
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
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostUsd: null,
    incomplete: [],
    sessions: 1,
    observedSessions: 0,
    activeSessions: 0,
    updatedAt: null,
    completeness: 'none',
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
    interruptedTurns: 1,
    unsettledTurns: 1,
    wallMs: 95_000,
    wallPartial: true,
    inputTokens: 150_000,
    outputTokens: 11_000,
    cachedInputTokens: 90_000,
    cacheWriteInputTokens: 0,
    estimatedCostUsd: null,
    incomplete: [],
  },
];

export const mockUsage: UsageV1 = {
  headline: { tokens: 195_244, estimatedCostUsd: null, completeness: 'partial', turns: 3, interventions: 1 },
  providers: [...mockUsageProviders],
  stages: [...mockUsageStages],
  turns: 3,
  failedTurns: 0,
  interruptedTurns: 1,
  unsettledTurns: 1,
  repairAttempts: 1,
  interventions: {
    total: 1,
    answers: 1,
    authorizations: 0,
    assessments: 0,
    retries: 0,
    rerunChecks: 0,
    recoveries: 0,
    revisions: 0,
    stops: 0,
    approvals: 0,
  },
  note: 'Provider token counts have different meanings. Estimated cost uses provider rates; billed cost is unknown.',
};

const command = { name: 'Tests', file: 'node', args: ['--test'], timeoutMs: 120_000 };

export const mockPlan: PlanView = {
  title: 'Add retry to the export job',
  outcome: 'The export job retries **transient** failures up to three times.',
  approach: 'Wrap `sendBatch` in a bounded retry.',
  criteria: ['A transient failure is retried', 'A permanent failure stops at once'],
  repository: { name: 'exporter', path: 'D:\\Projects\\exporter' },
  base: 'a'.repeat(40),
  workspace: { adapter: 'git', path: 'D:\\Projects\\grampus-task-1' },
  implementer: { id: 'codex', label: 'Codex', model: null },
  reviewer: { id: 'claude', label: 'Claude', model: 'claude-opus' },
  mode: 'automatic',
  workflowSummary:
    'Automatic workflow: implement, validate, repair, independently review and deliver within the approved scope.',
  reviewSummary: 'Review repair allowance: 1 round.',
  qualityPasses: [
    { id: 'simplification', title: 'Simplification', kind: 'lens', instructions: 'Prefer the simplest change.' },
  ],
  qualitySummary: 'Lenses are assessed by the independent reviewer.',
  context: { files: ['src/export.ts'], totalFiles: 120, exploration: true },
  preparation: null,
  revision: null,
  slices: [
    {
      title: 'Retry',
      approach: 'Add the retry loop.',
      criteria: ['A transient failure is retried'],
      files: { edit: ['src/export.ts'], create: ['test/retry.test.ts'], delete: [] },
      preparation: null,
      validation: command,
      acceptance: { ...command, name: 'Acceptance', expectedStdout: 'ok\n', expectations: null },
      delivery: { mode: 'commit', message: 'Add export retry' },
    },
  ],
};

const taskPath = (name: string) => `/api/tasks/task-1/${name}`;

export const mockAnswerAction = mockAction('answer', 'Send answers and continue', {
  kind: 'primary',
  path: taskPath('answer'),
  expected: 'decision-7',
  form: {
    kind: 'answers',
    intro: null,
    submitLabel: 'Send answers and continue',
    fields: [
      field({
        name: 'answer-0',
        label: 'Should the **old URL** redirect?',
        input: 'textarea',
        value: '',
        required: true,
        suggestions: ['Yes, permanently', 'No'],
        target: '/answers/redirect',
      }),
      field({
        name: 'answer-1',
        label: 'Keep the page title?',
        input: 'textarea',
        value: '',
        required: true,
        target: '/answers/a~1b',
      }),
    ],
  },
});

export const mockAssessAction = mockAction('assess', 'Record assessment and continue', {
  kind: 'primary',
  path: taskPath('assess'),
  expected: 'decision-7',
  form: {
    kind: 'assessment',
    intro: 'Assess the change against **Simplification**.',
    submitLabel: 'Record assessment and continue',
    fields: [
      field({
        name: 'outcome',
        label: 'Quality assessment outcome',
        input: 'select',
        required: true,
        options: [
          { value: 'passed', label: 'Passed', description: null },
          { value: 'failed', label: 'Failed: changes needed', description: null },
          { value: 'skipped', label: 'Skipped: assessment unavailable', description: null },
        ],
        target: '/outcome',
      }),
      field({
        name: 'summary',
        label: 'Your assessment',
        input: 'textarea',
        value: '',
        required: true,
        target: '/summary',
      }),
    ],
  },
});

const planJson = {
  brief: { title: 'Add retry', outcome: 'Old outcome', plan: 'Old plan' },
  workflowPolicy: { mode: 'automatic', repairRounds: 2 },
  reviewPolicy: { repairRounds: 1, arbitrator: { provider: 'codex' } },
  quality: { passes: [{ id: 'simplification', kind: 'lens' }] },
};

export const mockReviseAction = mockAction('revise', "Revise this task's plan", {
  path: taskPath('revise'),
  expected: 'decision-7',
  form: {
    kind: 'revision',
    intro: 'The revised plan needs fresh approval.',
    submitLabel: 'Prepare revised plan for approval',
    fields: [
      field({
        name: 'plan',
        label: 'Execution plan (JSON)',
        input: 'json',
        value: planJson,
        required: true,
        target: '/plan',
      }),
      field({
        name: 'title',
        label: 'Task name',
        input: 'text',
        value: 'Add retry',
        required: true,
        target: '/plan/brief/title',
      }),
      field({
        name: 'validation-repairs',
        label: 'Check repair allowance per slice',
        input: 'number',
        value: 2,
        required: true,
        min: 0,
        max: 5,
        target: '/plan/workflowPolicy/repairRounds',
      }),
      field({
        name: 'arbitrator',
        label: 'After the repair allowance',
        input: 'select',
        value: { provider: 'codex' },
        options: [
          { value: null, label: 'Stop for your decision', description: null },
          { value: { provider: 'codex' }, label: 'Fresh Codex arbitration', description: null },
          { value: { provider: 'claude' }, label: 'Fresh Claude arbitration', description: null },
        ],
        target: '/plan/reviewPolicy/arbitrator',
      }),
      field({
        name: 'quality-passes',
        label: 'Quality passes, in order',
        input: 'multiselect',
        value: [{ id: 'simplification', kind: 'lens' }],
        options: [
          {
            value: { id: 'simplification', kind: 'lens' },
            label: 'Simplification',
            description: 'Review lens · simplification',
          },
          { value: 'naming', label: 'Naming', description: 'Review lens · naming' },
          { value: 'refactor', label: 'Refactor', description: 'Edit pass · refactor' },
        ],
        target: '/plan/quality/passes',
      }),
      field({ name: 'references', label: 'Lines', input: 'lines', value: [], target: '/plan/notes' }),
    ],
  },
});

export const mockTask: TaskDetailV1 = {
  apiVersion: 1,
  revision: 'r7',
  id: 'task-1',
  header: {
    title: 'Add retry to the export job',
    outcome: 'The export job retries transient failures.',
    repository: { name: 'exporter', path: 'D:\\Projects\\exporter' },
    slice: { index: 1, count: 2, title: 'Retry' },
    status: 'awaiting_human',
    statusLabel: 'Your answer is needed',
    explanation: 'The implementer asked a question before continuing.',
    note: 'Answer with **care**.',
    stopReason: { code: 'AGENT_QUESTION', at: '2026-10-19T09:00:00.000Z' },
    nextStep: { kind: 'human', label: 'Answer the questions.', actionIds: ['answer'] },
    stalled: null,
    actionError: null,
    mode: 'automatic',
    stale: false,
  },
  workflow: [...mockStages],
  activity: null,
  decisions: [
    mockAnswerAction,
    mockReviseAction,
    mockAction('report', 'Download task report', {
      path: taskPath('report'),
      expected: null,
      request: { method: 'GET', path: taskPath('report'), body: null },
      body: null,
    }),
    mockAction('reset', 'Reset task', {
      path: taskPath('reset'),
      expected: 'decision-7',
      confirm: 'Restart planning from the original request?',
    }),
    mockAction('delete', 'Delete task', {
      kind: 'danger',
      path: taskPath('delete'),
      expected: 'decision-7',
      confirm: 'Delete this task from the dashboard?',
    }),
  ],
  results: {
    criteria: [
      { text: 'A transient failure is retried', state: 'failed', evidence: 'controller-verified' },
      { text: 'A permanent failure stops at once', state: 'pending', evidence: null },
    ],
    checks: [
      {
        id: 'check-1',
        name: 'Tests',
        purposeLabel: 'Validation',
        state: 'failed',
        stateLabel: 'Failed',
        evidence: 'controller-verified',
        issue: 'AssertionError: expected 3 retries',
        error: null,
        exitCode: 1,
        reason: 'exited',
        command: { file: 'node', args: ['--test'] },
        timeoutMs: 120_000,
        stdoutCharacters: 10,
        stderrCharacters: 40,
        outputTruncated: false,
        outputUnavailable: false,
        outputPath: '/api/tasks/task-1/check-output?checkId=check-1',
      },
    ],
    findingsTitle: 'Independent review findings',
    findings: [{ severity: 'blocking', description: 'Retries are unbounded.', evidence: 'src/export.ts line 12' }],
    lenses: [
      {
        id: 'simplification',
        title: 'Simplification',
        verdict: 'fail',
        summary: 'Too clever.',
        findings: [],
        recorded: { outcome: 'failed', evidence: 'agent-reported' },
      },
    ],
    qualityEdits: [],
    commits: [],
    unresolved: ['1 blocking review finding to address.'],
  },
  usage: mockUsage,
  details: {
    approval: { version: 3, digest: 'f'.repeat(64), approved: true },
    artifact: { artifact: 'sha256:abc', instructionsDigest: 'd'.repeat(64), head: 'b'.repeat(40) },
    changes: ['src/export.ts'],
    changesPath: '/api/v1/tasks/task-1/changes',
    plan: mockPlan,
    scope: null,
    references: [],
    workspace: { path: 'D:\\Projects\\grampus-task-1', adapter: 'git' },
    exploration: { calls: 4, readFiles: ['src/export.ts'] },
    timeline: {
      total: 12,
      recent: [
        {
          sequence: 12,
          at: '2026-10-19T09:00:00.000Z',
          type: 'guided.answer_requested',
          summary: 'Question asked',
          note: null,
          reasonCode: 'AGENT_QUESTION',
        },
      ],
      path: '/api/v1/tasks/task-1/timeline',
    },
    reportPath: '/api/tasks/task-1/report',
  },
  integrations: [{ name: 'linear', status: 'connected', tools: 12 }],
};

export const mockKickoff: KickoffDetailV1 = {
  apiVersion: 1,
  revision: 'k1',
  id: 'kickoff-1',
  title: 'Document the import format',
  status: 'awaiting_human',
  statusLabel: 'Your answer is needed',
  explanation: 'The planner asked a question.',
  request: 'Document the import format in docs/import.md',
  repository: { name: 'docs', path: 'D:\\Projects\\docs' },
  base: 'c'.repeat(40),
  provider: { id: 'claude', label: 'Claude', model: null },
  adapter: 'git',
  messages: [
    {
      role: 'user',
      author: 'You',
      at: '2026-10-19T08:00:00.000Z',
      kind: 'message',
      text: 'Document the import format',
    },
    { role: 'planner', author: 'Claude', at: '2026-10-19T08:01:00.000Z', kind: 'message', text: 'Which **version**?' },
  ],
  questions: [{ id: 'version', prompt: 'Which **version**?', suggestions: ['v2'] }],
  proposal: { digest: 'e'.repeat(64), plan: mockPlan },
  context: {
    exploration: true,
    files: [],
    totalFiles: 40,
    inventoryDigest: 'inv',
    directories: [{ path: 'docs', files: 40 }],
  },
  references: [],
  referenceSuggestions: [{ path: 'D:\\Specs', reason: 'Folder mentioned in the task description' }],
  activity: null,
  exploration: { calls: 0, readFiles: [] },
  integrations: [],
  error: null,
  actionError: null,
  taskId: null,
  actions: [
    mockAction('plan-answer', 'Send answers and continue', {
      kind: 'primary',
      path: '/api/kickoffs/kickoff-1/plan',
      expected: 'turn-3',
      form: {
        kind: 'answers',
        intro: null,
        submitLabel: 'Send answers and continue',
        fields: [
          field({
            name: 'answer-0',
            label: 'Which **version**?',
            input: 'textarea',
            value: '',
            required: true,
            suggestions: ['v2'],
            target: '/answers/version',
          }),
        ],
      },
    }),
    mockAction('prepare', 'Review for approval', {
      kind: 'primary',
      path: '/api/kickoffs/kickoff-1/prepare',
      expected: null,
      body: { digest: 'e'.repeat(64) },
    }),
    mockAction('update-references', 'Update reference folders', {
      path: '/api/kickoffs/kickoff-1/references',
      expected: 'turn-3',
      form: {
        kind: 'references',
        intro: null,
        submitLabel: 'Update reference folders',
        fields: [
          field({
            name: 'references',
            label: 'Absolute folder paths, one per line',
            input: 'lines',
            value: [],
            target: '/references',
          }),
        ],
      },
    }),
    mockAction('delete', 'Delete task', {
      kind: 'danger',
      path: '/api/kickoffs/kickoff-1/delete',
      expected: 'turn-3',
      confirm: 'Delete this task?',
    }),
  ],
};
