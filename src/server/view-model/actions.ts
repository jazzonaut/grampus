// Owns which dashboard actions exist for a task or planning conversation in a given state: their labels,
// consequences, the decision key they carry, the form they need, and why one is disabled. This is the
// single source of these rules; the client draws `ActionView`s and posts their `request` unchanged.
//
// Every action reuses an existing dashboard route (the server re-checks the decision key):
//
// | ActionView.id       | Route                                   | Body                                  |
// | ------------------- | --------------------------------------- | ------------------------------------- |
// | approve             | POST /api/tasks/:id/approve             | { expected, version, digest }         |
// | run                 | POST /api/tasks/:id/run                 | { expected }                          |
// | authorize           | POST /api/tasks/:id/authorize           | { expected }                          |
// | refresh-checkpoint  | POST /api/tasks/:id/retry               | { expected }                          |
// | assess              | POST /api/tasks/:id/assess              | { expected, outcome, summary }        |
// | answer              | POST /api/tasks/:id/answer              | { expected, answers: { [id]: text } } |
// | retry               | POST /api/tasks/:id/retry               | { expected }                          |
// | retry-preparation   | POST /api/tasks/:id/retry               | { expected }                          |
// | rerun-checks        | POST /api/tasks/:id/rerun-checks        | { expected }                          |
// | recover             | POST /api/tasks/:id/recover             | { expected }                          |
// | release-workspace   | POST /api/tasks/:id/release-workspace   | { expected }                          |
// | stop                | POST /api/tasks/:id/stop                | { expected }                          |
// | revise              | POST /api/tasks/:id/revise              | { expected, plan }                    |
// | reset, delete       | POST /api/{tasks,kickoffs}/:id/{reset,delete} | { expected }                    |
// | discard             | POST /api/tasks/:id/discard             | { expected }                          |
//
// Actions that start an agent turn or check (run, authorize, refresh-checkpoint, assess, answer, the
// retries and rerun-checks) need a free slot in the runner pool and are disabled while it is full.
// Approval is not: it stands and the server answers `{ ok, started: false }` so the task waits as ready.
// Recovery, workspace release, revision and stop never claim a slot.
// | report              | GET  /api/tasks/:id/report              | (none)                                |
// | plan-message        | POST /api/kickoffs/:id/plan             | { expected, message }                 |
// | plan-answer         | POST /api/kickoffs/:id/plan             | { expected, answers }                 |
// | prepare             | POST /api/kickoffs/:id/prepare          | { digest }                            |
// | update-context      | POST /api/kickoffs/:id/context          | { expected, files }                   |
// | update-references   | POST /api/kickoffs/:id/references       | { expected, references }              |
// | stop-planning       | POST /api/kickoffs/:id/stop             | { expected }                          |
// | recover-planning    | POST /api/kickoffs/:id/planner-recover  | { expected }                          |
import { workflowPolicyBounds } from '../../config/limits.js';
import type { GuidedPlan } from '../../domain/guided-plan.js';
import type { QualityPassDefinition } from '../../domain/quality-passes.js';
import type { Stage } from '../../orchestration/guided/state.js';
import { isSpendingStop } from '../../orchestration/guided/spending.js';
import type { ActionForm, ActionId, ActionKind, ActionView, FormField, FormOption, JsonValue } from '../api-types.js';
import { isLive, needsRecovery, type TaskStatusFacts } from './status.js';

/** A question an agent or the planner asked. */
export interface PendingQuestion {
  id: string;
  prompt: string;
  choices: string[];
}

/** Everything the task action rules depend on. */
export interface TaskActionFacts extends TaskStatusFacts {
  /** A request to finish the current operation and pause before the next one. */
  pauseRequested: boolean;
  taskId: string;
  /** Membership directs initial approval and continuation to the comparison instead of this task. */
  comparisonId: string | null;
  /** The decision key of the displayed state (`guidedDecisionKey`). */
  expected: string;
  stage: Stage;
  version: number;
  digest: string;
  automatic: boolean;
  /** Why the stopped check cannot be rerun, or null when it can (`rerunChecksIneligibility`). */
  rerunProblem: string | null;
  /** An unused, failed standalone worktree reservation can be released. */
  releasable: boolean;
  /** Why file authorization cannot be prepared, while it is pending. */
  scopeError: string | null;
  /** Why the runner pool cannot take this task now (`poolFullReason`), or null when work may start. */
  poolFull: string | null;
  questions: readonly PendingQuestion[];
  /** The plan's selected lenses, assessed in supervised mode. */
  lenses: readonly QualityPassDefinition[];
  plan: GuidedPlan;
  /** Every quality pass a revision may select. */
  availablePasses: readonly QualityPassDefinition[];
}

/** What {@link action} needs to build an `ActionView`; omitted fields take their usual defaults. */
export interface ActionSpec {
  id: ActionId;
  label: string;
  kind: ActionKind;
  description: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: { [key: string]: JsonValue };
  expected?: string | null;
  confirm?: string | null;
  form?: ActionForm | null;
  disabledReason?: string | null;
}

/** An `ActionView`: a POST unless `method` says otherwise, enabled unless it has a `disabledReason`. */
export function action(spec: ActionSpec): ActionView {
  const method = spec.method ?? 'POST';
  const expected = spec.expected ?? null;
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    description: spec.description,
    expected,
    confirm: spec.confirm ?? null,
    form: spec.form ?? null,
    enabled: !spec.disabledReason,
    disabledReason: spec.disabledReason ?? null,
    request: {
      method,
      path: spec.path,
      body: method === 'GET' ? null : (spec.body ?? (expected === null ? {} : { expected })),
    },
  };
}

/** A JSON pointer segment (RFC 6901). */
function pointer(...segments: string[]): string {
  return segments.map(segment => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** A form field with empty defaults for everything `spec` leaves out. */
export function field(spec: Partial<FormField> & Pick<FormField, 'name' | 'label' | 'input' | 'target'>): FormField {
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

/** A choice of a select or multiselect field. */
export function option(value: JsonValue, label: string, description: string | null = null): FormOption {
  return { value, label, description };
}

/** One answer field per question, written to `answers[<question id>]`. */
export function answerFields(questions: readonly PendingQuestion[]): FormField[] {
  return questions.map((question, index) =>
    field({
      name: `answer-${index}`,
      label: question.prompt,
      input: 'textarea',
      value: '',
      required: true,
      suggestions: question.choices,
      help: question.choices.length ? 'Choose a suggestion to fill your answer, then edit it if needed.' : null,
      target: pointer('answers', question.id),
    }),
  );
}

function assessmentForm(lenses: readonly QualityPassDefinition[]): ActionForm {
  return {
    kind: 'assessment',
    intro: [
      'Inspect the changes and check output, then assess them against each quality lens below. Your outcome and summary are recorded for every lens listed.',
      ...lenses.map(lens => `**${lens.title}** (\`${lens.id}\`)\n\n${lens.instructions}`),
    ].join('\n\n'),
    fields: [
      field({
        name: 'outcome',
        label: 'Quality assessment outcome',
        input: 'select',
        value: null,
        required: true,
        options: [
          option('passed', 'Passed'),
          option('failed', 'Failed: changes needed'),
          option('skipped', 'Skipped: assessment unavailable'),
        ],
        target: '/outcome',
      }),
      field({
        name: 'summary',
        label: 'Your assessment',
        input: 'textarea',
        value: '',
        required: true,
        placeholder: 'Explain what you inspected and why this outcome applies.',
        help: 'A pass continues through independent review, acceptance checks and a verified local commit. Failed or skipped assessments stop progression.',
        target: '/summary',
      }),
    ],
    submitLabel: 'Record assessment and continue',
  };
}

function passOption(pass: QualityPassDefinition, value: JsonValue): FormOption {
  return option(value, pass.title, `${pass.kind === 'lens' ? 'Review lens' : 'Edit pass'} · ${pass.id}`);
}

/** Passes already in the plan keep their approved definitions; others are selected by id. */
function qualityOptions(plan: GuidedPlan, available: readonly QualityPassDefinition[]): FormOption[] {
  const selected = plan.quality.passes.map(pass => passOption(pass, { ...pass }));
  const others = available
    .filter(pass => !plan.quality.passes.some(item => item.id === pass.id))
    .map(pass => passOption(pass, pass.id));
  return [...selected, ...others];
}

function arbitratorOptions(plan: GuidedPlan): FormOption[] {
  const current = plan.reviewPolicy?.arbitrator;
  return [
    option(null, 'Stop for your decision'),
    ...(['codex', 'claude'] as const).map(provider =>
      option(
        current?.provider === provider ? { provider, model: current.model } : { provider },
        `Fresh ${provider === 'codex' ? 'Codex' : 'Claude'} arbitration`,
      ),
    ),
  ];
}

function numberField(name: string, label: string, target: string, value: number, bounds: { min: number; max: number }) {
  return field({ name, label, input: 'number', value, required: true, min: bounds.min, max: bounds.max, target });
}

/** The separate mechanical and shared behavioural capacities the person explicitly approves. */
function repairFields(policy: GuidedPlan['workflowPolicy']) {
  return [
    numberField(
      'readiness-repairs',
      'Readiness repair allowance per slice',
      '/plan/workflowPolicy/readinessRounds',
      policy.readinessRounds,
      workflowPolicyBounds.readinessRounds,
    ),
    numberField(
      'validation-repairs',
      'Shared behavioural repair allowance per slice',
      '/plan/workflowPolicy/repairRounds',
      policy.repairRounds,
      workflowPolicyBounds.repairRounds,
    ),
  ];
}

/**
 * The revision form: the whole plan as JSON first (files, checks, criteria and slices), then the
 * individual fields, which take precedence because they are applied after it.
 */
export function revisionForm(plan: GuidedPlan, available: readonly QualityPassDefinition[]): ActionForm {
  const policy = plan.workflowPolicy;
  return {
    kind: 'revision',
    intro:
      'Keep workspace files, commits and history. Delivered slices stay fixed. The revised plan needs fresh approval, checks and review.',
    fields: [
      field({
        name: 'plan',
        label: 'Execution plan (JSON): files, checks, criteria and slices',
        input: 'json',
        value: JSON.parse(JSON.stringify(plan)) as JsonValue,
        required: true,
        help: 'Edit the execution plan to change scope or checks. The fields below take precedence.',
        target: '/plan',
      }),
      field({
        name: 'title',
        label: 'Task name',
        input: 'text',
        value: plan.brief.title,
        required: true,
        target: '/plan/brief/title',
      }),
      field({
        name: 'outcome',
        label: 'Revised outcome',
        input: 'textarea',
        value: plan.brief.outcome,
        required: true,
        target: '/plan/brief/outcome',
      }),
      field({
        name: 'approach',
        label: 'Approach',
        input: 'textarea',
        value: plan.brief.plan,
        required: true,
        target: '/plan/brief/plan',
      }),
      field({
        name: 'workflow-mode',
        label: 'Workflow',
        input: 'select',
        value: policy.mode,
        required: true,
        options: [
          option('automatic', 'Automatic within approved scope'),
          option('supervised', 'Supervised checkpoints'),
        ],
        target: '/plan/workflowPolicy/mode',
      }),
      ...repairFields(policy),
      numberField(
        'task-turns',
        'Task-wide agent turn allowance',
        '/plan/workflowPolicy/maxTaskTurns',
        policy.maxTaskTurns,
        workflowPolicyBounds.maxTaskTurns,
      ),
      {
        ...numberField(
          'task-tokens',
          'Task-wide token threshold (0 disables)',
          '/plan/workflowPolicy/maxTaskTokens',
          policy.maxTaskTokens,
          workflowPolicyBounds.maxTaskTokens,
        ),
        help: 'Totals include linked planning, all slices, retries and plan versions. Checked before every agent turn; an active turn may exceed the threshold. Missing token usage stops further turns when enabled.',
      },
      numberField(
        'session-turns',
        'Start a fresh conversation after this many turns',
        '/plan/workflowPolicy/maxSessionTurns',
        policy.maxSessionTurns,
        workflowPolicyBounds.maxSessionTurns,
      ),
      {
        ...numberField(
          'context-tokens',
          'Start fresh at observed context tokens',
          '/plan/workflowPolicy/maxContextTokens',
          policy.maxContextTokens,
          workflowPolicyBounds.maxContextTokens,
        ),
        help: 'Conversation limits apply to implementers and reviewers at settled retry boundaries. New slices and arbitration always start fresh. Unknown context size falls back to the turn limit.',
      },
      field({
        name: 'arbitrator',
        label: 'After the repair allowance',
        input: 'select',
        value:
          arbitratorOptions(plan).find(
            item => JSON.stringify(item.value) === JSON.stringify(plan.reviewPolicy?.arbitrator ?? null),
          )?.value ?? null,
        options: arbitratorOptions(plan),
        help: 'Automatic repairs keep the approved scope and require a fresh independent verdict. An unresolved arbitration stops the task.',
        target: '/plan/reviewPolicy/arbitrator',
      }),
      field({
        name: 'quality-passes',
        label: 'Quality passes, in order',
        input: 'multiselect',
        value: plan.quality.passes.map(pass => ({ ...pass })),
        options: qualityOptions(plan, available),
        help: 'Lenses are assessed in review; edit passes run before validation in the listed order. Passes already in this plan keep their approved instructions. Choose none to select no passes.',
        target: '/plan/quality/passes',
      }),
    ],
    submitLabel: 'Prepare revised plan for approval',
  };
}

const lifecycleConfirm = {
  reset: 'Restart planning from the original request? Existing workspace files and commits will be kept.',
  delete: 'Delete this task from the dashboard? Existing workspace files, commits and recorded history will be kept.',
} as const;

/** Reset and delete: refused while work is live or uncertain. */
export function lifecycleActions(
  kind: 'tasks' | 'kickoffs',
  id: string,
  expected: string,
  disabledReason: string | null,
): ActionView[] {
  return (['reset', 'delete'] as const).map(name =>
    action({
      id: name,
      label: name === 'reset' ? 'Reset task' : 'Delete task',
      kind: name === 'reset' ? 'secondary' : 'danger',
      description:
        name === 'reset'
          ? 'Restarts planning from the original request in a fresh conversation and baseline. The old task is hidden; its workspace files, commits and history are kept.'
          : 'Hides the task. Workspace files, commits and recorded history are kept.',
      path: `/api/${kind}/${id}/${name}`,
      expected,
      confirm: lifecycleConfirm[name],
      disabledReason,
    }),
  );
}

type Builder = (f: TaskActionFacts) => ActionView;

const route = (f: TaskActionFacts, name: string) => `/api/tasks/${f.taskId}/${name}`;

const builders = {
  approve: f =>
    action({
      id: 'approve',
      label: f.automatic ? 'Approve and start' : 'Approve this plan',
      kind: 'primary',
      description: f.automatic
        ? 'Approves this exact version and digest and starts the automatic run within the approved scope.'
        : 'Approves this exact version and digest; supervised checkpoints follow.',
      path: route(f, 'approve'),
      expected: f.expected,
      body: { expected: f.expected, version: f.version, digest: f.digest },
      disabledReason: f.comparisonId ? 'Open Comparisons and choose Approve all profiles for this comparison.' : null,
    }),
  run: f =>
    action({
      id: 'run',
      label: 'Continue task',
      kind: 'primary',
      description: 'Continues the approved task to its next decision point.',
      path: route(f, 'run'),
      expected: f.expected,
      disabledReason: f.comparisonId ? 'Open Comparisons and choose Run comparison to continue the group.' : f.poolFull,
    }),
  authorize: f =>
    action({
      id: 'authorize',
      label: 'Authorize these files and start',
      kind: 'primary',
      description: 'Authorizes exactly the files shown and starts implementation and validation.',
      path: route(f, 'authorize'),
      expected: f.expected,
      disabledReason: f.scopeError ? `File authorization could not be prepared: ${f.scopeError}` : f.poolFull,
    }),
  'refresh-checkpoint': f =>
    action({
      id: 'refresh-checkpoint',
      label: 'Refresh file checkpoint',
      kind: 'secondary',
      description: 'Takes a fresh checkpoint of the workspace in a new attempt; files are kept.',
      path: route(f, 'retry'),
      expected: f.expected,
      disabledReason: f.poolFull,
    }),
  assess: f =>
    action({
      id: 'assess',
      label: 'Record assessment and continue',
      kind: 'primary',
      description: 'Records your outcome and summary for every selected lens, then continues to independent review.',
      path: route(f, 'assess'),
      expected: f.expected,
      form: assessmentForm(f.lenses),
      disabledReason: f.poolFull,
    }),
  answer: f =>
    action({
      id: 'answer',
      label: 'Send answers and continue',
      kind: 'primary',
      description: 'Sends your answers to the same agent conversation for these exact questions.',
      path: route(f, 'answer'),
      expected: f.expected,
      form: {
        kind: 'answers',
        intro: null,
        fields: answerFields(f.questions),
        submitLabel: 'Send answers and continue',
      },
      disabledReason: f.poolFull,
    }),
  retry: f =>
    action({
      id: 'retry',
      label: f.status === 'awaiting_assessment' ? 'Revise implementation' : 'Retry repair',
      kind: f.status === 'blocked' && f.rerunProblem !== null ? 'primary' : 'secondary',
      description:
        'Starts a fresh implementation attempt with the failure as feedback, keeping files and resuming eligible conversations. Use it after staging files mid-run.',
      path: route(f, 'retry'),
      expected: f.expected,
      disabledReason: f.poolFull,
    }),
  'retry-preparation': f =>
    action({
      id: 'retry-preparation',
      label: 'Retry preparation',
      kind: 'primary',
      description:
        'Reruns the failed preparation step in the same attempt; the implementation and retained files are kept.',
      path: route(f, 'retry'),
      expected: f.expected,
      disabledReason: f.poolFull,
    }),
  'rerun-checks': f =>
    action({
      id: 'rerun-checks',
      label: 'Rerun checks',
      kind: 'primary',
      description:
        'Runs the same check again on the same change, without an agent turn or a new attempt. Refused if the workspace changed since.',
      path: route(f, 'rerun-checks'),
      expected: f.expected,
      disabledReason: f.poolFull,
    }),
  recover: f =>
    action({
      id: 'recover',
      label: 'Recover saved work',
      kind: needsRecovery(f) ? 'primary' : 'secondary',
      description:
        'Reconciles the previous operation from saved process and result evidence. It never replays a turn, command or Git write and does not start the next step.',
      path: route(f, 'recover'),
      expected: f.expected,
    }),
  'release-workspace': f =>
    action({
      id: 'release-workspace',
      label: 'Release unused reservation',
      kind: 'secondary',
      description:
        'Clears the failed worktree reservation once Git exit and absence of files are confirmed. Deletes nothing.',
      path: route(f, 'release-workspace'),
      expected: f.expected,
    }),
  stop: f =>
    action({
      id: 'stop',
      label: f.stopRequested ? 'Stop requested' : isLive(f) && f.status === 'running' ? 'Stop now' : 'Request stop',
      kind: 'danger',
      description: 'Requests settlement of active work. It does not claim processes have already exited.',
      path: route(f, 'stop'),
      expected: f.expected,
      disabledReason: f.stopRequested
        ? 'A stop was already requested; waiting for the current operation to settle.'
        : !f.owner
          ? 'The worker has not claimed the task yet; wait a moment.'
          : null,
    }),
  pause: f =>
    action({
      id: 'pause',
      label: f.pauseRequested ? 'Pause requested' : 'Pause after this step',
      kind: 'secondary',
      description:
        'Finishes the current operation, then waits before starting anything else. Files, evidence and conversations are kept.',
      path: route(f, 'pause'),
      expected: f.expected,
      disabledReason: f.pauseRequested
        ? 'The current operation will finish, then the task will pause.'
        : f.stopRequested
          ? 'A stop is already requested.'
          : !f.owner
            ? 'Wait for the worker to claim the task.'
            : null,
    }),
  revise: f =>
    action({
      id: 'revise',
      label: "Revise this task's plan",
      kind: 'secondary',
      description:
        'Edits the outcome, approach, policies, quality passes or (advanced) files, checks, criteria and remaining slices. Needs fresh approval.',
      path: route(f, 'revise'),
      expected: f.expected,
      form: revisionForm(f.plan, f.availablePasses),
      disabledReason:
        isLive(f) || f.pending || f.status === 'recovery_required'
          ? 'Stop and recover active or uncertain work before revising.'
          : null,
    }),
  report: f =>
    action({
      id: 'report',
      label: 'Download task report',
      kind: f.status === 'complete' ? 'primary' : 'secondary',
      description: 'A Markdown report built from the journal: checks, reviews, assessments and delivery evidence.',
      path: route(f, 'report'),
      method: 'GET',
    }),
} satisfies Partial<Record<ActionId, Builder>>;

type TaskActionId = keyof typeof builders;

/**
 * Ids of the actions that resolve the current state, in display order (primary first): the subset that
 * attention items and the next step offer.
 */
export function resolvingActionIds(f: TaskActionFacts): TaskActionId[] {
  if (f.stale) return [];
  if (f.jobRunning || (f.owner && f.status === 'running')) return f.jobRunning ? ['stop'] : ['stop', 'recover'];
  if (needsRecovery(f))
    return ['recover', ...(f.releasable ? ['release-workspace' as const] : []), ...(f.owner ? ['stop' as const] : [])];
  return settledResolving(f);
}

function settledResolving(f: TaskActionFacts): TaskActionId[] {
  switch (f.status) {
    case 'draft':
      return ['approve'];
    case 'ready':
      return ['run'];
    case 'awaiting_scope':
      return ['authorize', 'refresh-checkpoint'];
    case 'awaiting_assessment':
      return ['assess', 'retry'];
    case 'awaiting_answer':
      return ['answer'];
    case 'blocked':
      if (isSpendingStop(f.stopCode)) return ['revise'];
      if (f.stopCode === 'GUIDANCE_PENDING') return [];
      if (f.stopCode === 'USER_PAUSED') return ['run'];
      if (f.stage === 'preparation' || f.stage === 'refresh') return ['retry-preparation'];
      return f.rerunProblem === null ? ['rerun-checks', 'retry'] : ['retry'];
    case 'running':
      return ['recover'];
    case 'recovery_required':
      return ['recover'];
    case 'complete':
      return ['report'];
  }
}

/**
 * Every task action available now: the ones that resolve the current state first, then revision, the
 * report and lifecycle management. A stale plan offers only lifecycle management.
 */
export function taskActions(f: TaskActionFacts): ActionView[] {
  const first = resolvingActionIds(f);
  if (first.includes('stop') && !needsRecovery(f)) first.push('pause');
  const management: TaskActionId[] = f.stale ? [] : (['revise', 'report'] as const).filter(id => !first.includes(id));
  const busy = isLive(f) || f.pending || f.status === 'recovery_required';
  return [
    ...[...first, ...management].map(id => builders[id](f)),
    ...lifecycleActions(
      'tasks',
      f.taskId,
      f.expected,
      busy ? 'Stop the task and confirm settlement or recovery before resetting or deleting it.' : null,
    ),
    ...(f.status === 'recovery_required' && !f.jobRunning
      ? [
          action({
            id: 'discard',
            label: 'Discard task',
            kind: 'danger',
            description:
              'Remove this abandoned task from the dashboard. Uncertain operations and workspace locks are retained; its controllers must have exited.',
            path: route(f, 'discard'),
            expected: f.expected,
            confirm:
              'Discard this task? It cannot restart. Files, commits and recovery evidence are kept, and uncertain workspaces stay locked. This does not stop tools that may still be running. Any containing comparison cannot run again.',
          }),
        ]
      : []),
  ];
}

/** Everything the planning action rules depend on. */
export interface KickoffActionFacts {
  kickoffId: string;
  /** The planning turn key of the displayed conversation. */
  turnKey: string;
  phase: 'idle' | 'running' | 'awaiting_answer' | 'stop_requested' | 'interrupted' | 'failed' | 'recovery_required';
  /** A planner run is recorded on the session. */
  run: boolean;
  jobRunning: boolean;
  hasMessages: boolean;
  questions: readonly PendingQuestion[];
  candidateDigest: string | null;
  error: string | null;
  converted: boolean;
  /** Starting file hints and their inventory, when the conversation has an editable context. */
  context: { files: readonly string[] } | null;
  references: readonly string[];
}

const kickoffRoute = (f: KickoffActionFacts, name: string) => `/api/kickoffs/${f.kickoffId}/${name}`;

function messageAction(f: KickoffActionFacts): ActionView {
  return action({
    id: 'plan-message',
    label: f.hasMessages ? 'Send message' : 'Prepare a plan',
    kind: f.candidateDigest ? 'secondary' : 'primary',
    description: 'Sends one planning turn; this uses subscription usage.',
    path: kickoffRoute(f, 'plan'),
    expected: f.turnKey,
    form: {
      kind: 'message',
      intro: null,
      fields: [
        field({
          name: 'message',
          label: f.hasMessages ? 'Refine the plan' : 'Start planning',
          input: 'textarea',
          value: '',
          required: f.hasMessages,
          placeholder: 'Ask for changes or add an example…',
          target: '/message',
        }),
      ],
      submitLabel: f.hasMessages ? 'Send message' : 'Prepare a plan',
    },
  });
}

function editingActions(f: KickoffActionFacts): ActionView[] {
  const actions: ActionView[] = [];
  if (f.phase === 'awaiting_answer')
    actions.push(
      action({
        id: 'plan-answer',
        label: 'Send answers and continue',
        kind: 'primary',
        description: 'Sends your answers to the planner for these exact questions.',
        path: kickoffRoute(f, 'plan'),
        expected: f.turnKey,
        form: {
          kind: 'answers',
          intro: null,
          fields: answerFields(f.questions),
          submitLabel: 'Send answers and continue',
        },
      }),
    );
  else actions.push(messageAction(f));
  if (f.candidateDigest && !f.error && f.phase === 'idle')
    actions.unshift(
      action({
        id: 'prepare',
        label: 'Create task for review',
        kind: 'primary',
        description:
          'Freezes this proposal as an unapproved task for you to inspect. It does not approve or start anything.',
        path: kickoffRoute(f, 'prepare'),
        body: { digest: f.candidateDigest },
      }),
    );
  if (f.context)
    actions.push(
      action({
        id: 'update-context',
        label: 'Update file hints',
        kind: 'secondary',
        description: 'Changes the optional starting files. Invalidates the previous proposal and starts no inference.',
        path: kickoffRoute(f, 'context'),
        expected: f.turnKey,
        form: {
          kind: 'context',
          intro: 'File hints are optional and do not grant edit permission.',
          fields: [
            field({
              name: 'files',
              label: 'Optional starting paths, one per line',
              input: 'lines',
              value: [...f.context.files],
              target: '/files',
            }),
          ],
          submitLabel: 'Update file hints',
        },
      }),
    );
  actions.push(
    action({
      id: 'update-references',
      label: 'Update reference folders',
      kind: 'secondary',
      description:
        'Changes the read-only reference folders. Invalidates the proposed plan; send a message to continue planning.',
      path: kickoffRoute(f, 'references'),
      expected: f.turnKey,
      form: {
        kind: 'references',
        intro:
          'Agents can search and read these folders throughout the task. File changes stay confined to the task workspace.',
        fields: [
          field({
            name: 'references',
            label: 'Absolute folder paths, one per line',
            input: 'lines',
            value: [...f.references],
            target: '/references',
          }),
        ],
        submitLabel: 'Update reference folders',
      },
    }),
  );
  return actions;
}

/** Every planning action available now. A converted conversation is managed through its task. */
export function kickoffActions(f: KickoffActionFacts): ActionView[] {
  if (f.converted) return [];
  const active = f.jobRunning || f.phase === 'running' || f.phase === 'stop_requested';
  const uncertain = f.run || f.phase === 'recovery_required';
  const actions: ActionView[] = [];
  if (active && f.run)
    actions.push(
      action({
        id: 'stop-planning',
        label: f.phase === 'stop_requested' ? 'Stop requested' : 'Stop planning',
        kind: 'danger',
        description: 'Asks the planner to stop. It does not claim the provider has exited.',
        path: kickoffRoute(f, 'stop'),
        expected: f.turnKey,
        disabledReason:
          f.phase === 'stop_requested' ? 'A stop was already requested; waiting for the planner to settle.' : null,
      }),
    );
  else if (!active && uncertain)
    actions.push(
      action({
        id: 'recover-planning',
        label: 'Recover planning session',
        kind: 'primary',
        description:
          'Proves that the earlier planner processes exited and settles the session. It never resends a turn.',
        path: kickoffRoute(f, 'planner-recover'),
        expected: f.turnKey,
      }),
    );
  else if (!active) actions.push(...editingActions(f));
  return [
    ...actions,
    ...lifecycleActions(
      'kickoffs',
      f.kickoffId,
      f.turnKey,
      active || uncertain ? 'Stop planning and confirm settlement or recovery before resetting or deleting it.' : null,
    ),
  ];
}

/** The planning actions that resolve the current state: everything except reference, hint and lifecycle edits. */
export function kickoffResolvingActions(actions: readonly ActionView[]): ActionView[] {
  return actions.filter(
    item => !['reset', 'delete', 'update-context', 'update-references'].includes(item.id) && item.enabled,
  );
}
