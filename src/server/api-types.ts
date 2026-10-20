// Pins the typed, versioned dashboard API (v1): the response shapes of `GET /api/v1/*` that the Vue
// client renders, the lookup and action routes it also calls, and the error envelope every route uses. Every presentation decision (status vocabulary, labels, explanations, which actions
// exist and why one is disabled) is made by the server view model (`server/view-model/`), so the client
// draws these values and never re-derives business rules.
//
// This file holds type declarations only: no runtime code and no imports, so the web client can import
// it through a relative path with `import type` without bundling any Node code.

/** The version every v1 response carries in `apiVersion`. A breaking change gets a new route prefix. */
export type ApiVersion = 1;

/** Any JSON value; used where a form writes into a request body. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * The fixed status vocabulary of tasks, planning conversations and attention items:
 * - `working`: the controller or an agent is making progress now.
 * - `awaiting_human`: nothing continues until you decide, answer or approve.
 * - `verified`: evidence the controller itself checked (a passing check, a verified commit).
 * - `failed`: settled evidence says the work did not pass; a person decides what next.
 * - `blocked`: an operational problem (timeout, uncertain process, recovery) stops progress.
 * - `unknown`: the state cannot be established; never shown as success.
 * - `idle`: settled and ready, waiting for an explicit continue.
 * - `complete`: delivered locally with every gate passed.
 * - `stopping`: a stop was requested and active work is settling.
 */
export type PresentationStatus =
  'working' | 'awaiting_human' | 'verified' | 'failed' | 'blocked' | 'unknown' | 'idle' | 'complete' | 'stopping';

/** State of one workflow stage or lens. `unknown` is never drawn as passed. */
export type StageState = 'passed' | 'pending' | 'active' | 'failed' | 'unknown' | 'skipped';

/**
 * Who established a result. `controller-verified`: Grampus ran or verified it itself (checks,
 * acceptance, the delivered commit). `agent-reported`: an agent's claim or verdict, bound to the exact
 * artifact but not re-verified (implementation, edit passes, the independent review). `human-assessed`:
 * your own recorded assessment (supervised mode).
 */
export type EvidenceSource = 'controller-verified' | 'agent-reported' | 'human-assessed';

/** A provider Grampus drives. */
export type ProviderId = 'codex' | 'claude';

/** A provider with its display name. */
export interface ProviderView {
  id: ProviderId;
  /** "Codex" or "Claude". */
  label: string;
  /** The configured model, or null for the provider default. */
  model: string | null;
}

/** A repository folder with a short name for lists. */
export interface RepositoryView {
  /** The last path segment, e.g. `exporter`. */
  name: string;
  path: string;
}

/** Running work that has journaled nothing for `stallWarningMs`. Nothing has been stopped. */
export interface StallV1 {
  /** When the silence crossed the threshold. */
  since: string;
  lastActivityAt: string;
  /** What went silent, e.g. "Codex session" or "check Tests". */
  owner: string;
  /** One sentence for the badge tooltip and notice. */
  message: string;
}

// ---------------------------------------------------------------------------------------------------
// Actions

/**
 * Every action the dashboard offers. The route and body each one posts are in
 * {@link ActionView.request}; `server/view-model/actions.ts` documents the mapping.
 */
export type ActionId =
  | 'approve'
  | 'run'
  | 'authorize'
  | 'refresh-checkpoint'
  | 'assess'
  | 'answer'
  | 'retry'
  | 'retry-preparation'
  | 'rerun-checks'
  | 'recover'
  | 'release-workspace'
  | 'stop'
  | 'pause'
  | 'queue-guidance'
  | 'cancel-guidance'
  | 'revise'
  | 'reset'
  | 'delete'
  | 'report'
  | 'plan-message'
  | 'plan-answer'
  | 'prepare'
  | 'update-context'
  | 'update-references'
  | 'stop-planning'
  | 'recover-planning'
  | 'save-settings'
  | 'open-orca'
  | 'comparison-select'
  | 'comparison-preview'
  | 'comparison-integrate'
  | 'comparison-recover-integration';

/** Visual weight: one `primary` per decision at most; `danger` hides or discards work. */
export type ActionKind = 'primary' | 'secondary' | 'danger';

/**
 * The exact request an action sends. The client copies `body`, writes each form field's value at its
 * `target` and sends the result unchanged: decision keys, versions and digests are already in `body`.
 */
export interface ActionRequest {
  method: 'GET' | 'POST';
  /** An existing dashboard route, e.g. `/api/tasks/<id>/answer`. */
  path: string;
  /** Null for a GET. */
  body: { [key: string]: JsonValue } | null;
}

/** How a form field is edited and how its value is written into the request body. */
export type FormInput =
  /** One line of text; written as a string. */
  | 'text'
  /** Several lines of text; written as a string. */
  | 'textarea'
  /** Written as a number. */
  | 'number'
  /** One of `options`; written as the chosen option's `value`. A null value removes the property. */
  | 'select'
  /** An ordered choice of `options`; written as the array of chosen options' values, in chosen order. */
  | 'multiselect'
  /** One entry per line; written as an array of the trimmed, nonempty lines. */
  | 'lines'
  /** JSON text; written as the parsed value. */
  | 'json';

/** One choice of a `select` or `multiselect` field. */
export interface FormOption {
  value: JsonValue;
  label: string;
  description: string | null;
}

/**
 * One input of an action's form. Fields are applied in order, so a later field overrides what an
 * earlier `json` field wrote at the same place.
 */
export interface FormField {
  /** Stable within the form; also the HTML id suffix. */
  name: string;
  label: string;
  input: FormInput;
  /** The current value to start editing from. */
  value: JsonValue;
  required: boolean;
  /** Shown under the field; Markdown. */
  help: string | null;
  /** Answer suggestions: choosing one fills the field for editing, it is not sent by itself. */
  suggestions: string[];
  options: FormOption[];
  min: number | null;
  max: number | null;
  step: number | null;
  placeholder: string | null;
  /**
   * JSON pointer into the request body where the value is written, e.g. `/answers/output`,
   * `/summary` or `/plan/brief/title`. Missing intermediate objects are created.
   */
  target: string;
}

/** The input an action needs before it can be sent. */
export interface ActionForm {
  kind: 'answers' | 'assessment' | 'revision' | 'message' | 'context' | 'references' | 'settings';
  /** Introductory text shown above the fields; Markdown. */
  intro: string | null;
  fields: FormField[];
  /** The submit button label. */
  submitLabel: string;
}

/** One action as the dashboard should offer it. */
export interface ActionView {
  id: ActionId;
  label: string;
  kind: ActionKind;
  /** What happens when you choose it, in one or two sentences. */
  description: string;
  /**
   * The decision key (or planning turn key) of the state this action was offered for. The server
   * refuses the action with 409 when the task has changed since. Null for actions that bind no state.
   */
  expected: string | null;
  /** A confirmation question to ask first, for reset and delete; null when none is needed. */
  confirm: string | null;
  form: ActionForm | null;
  enabled: boolean;
  /** Why the action is unavailable; null when it is enabled. */
  disabledReason: string | null;
  request: ActionRequest;
}

// ---------------------------------------------------------------------------------------------------
// Settings

/** `GET /api/v1/settings`: the settings file of this installation and the form that saves it. */
export interface SettingsV1 {
  apiVersion: ApiVersion;
  /** The `config.json` this dashboard reads and writes, or null when it was started without one. */
  file: string | null;
  /** The saved file differs from the settings this dashboard started with: a restart applies it. */
  restartRequired: boolean;
  /** Why the saved file would be refused at the next start, or null when it is absent or valid. */
  problem: string | null;
  /**
   * Saves the form as `config.json` (`POST /api/settings`). Each field holds the stored value; an
   * empty field is left out of the file and keeps the built-in default. `expected` is the file's
   * revision, so a change made meanwhile is refused with 409 instead of being overwritten.
   */
  save: ActionView;
}

// ---------------------------------------------------------------------------------------------------
// Health

/** Overall integration readiness. */
export type OverallHealth = 'ready' | 'degraded' | 'blocked' | 'unknown';

/** Status of one integration or capability, as `doctor` recorded it. */
export type IntegrationStatusV1 =
  'healthy' | 'failed' | 'untested' | 'not_configured' | 'auth_unavailable' | 'temporarily_unavailable';

/** One capability row of an integration. */
export interface CapabilityV1 {
  name: string;
  label: string;
  status: IntegrationStatusV1;
  /** E.g. "Not tested", "Sign-in needed". */
  statusLabel: string;
  /** Sanitised detail; empty when there is nothing to add. */
  detail: string;
}

/** One integration (Codex, Claude, Git, Node, Windows PowerShell, Orca). */
export interface IntegrationHealthV1 {
  id: string;
  label: string;
  required: boolean;
  status: IntegrationStatusV1;
  statusLabel: string;
  version: string | null;
  sdkVersion: string | null;
  capabilities: CapabilityV1[];
}

/** The header health card. Health is informational and never a gate. */
export interface HealthSummaryV1 {
  overall: OverallHealth;
  /** "Integrations healthy", "Integrations need attention" or "Integrations not checked yet". */
  label: string;
  /** One sentence naming the affected integration and capability, or why all is well. */
  reason: string;
  checkedAt: string | null;
  /** The stored result is older than `healthCheckIntervalMs`. */
  stale: boolean;
  /** Provider version change warnings since the last successful delivery. */
  warnings: string[];
  integrations: IntegrationHealthV1[];
}

// ---------------------------------------------------------------------------------------------------
// Usage

/** A measured usage quantity. */
export type UsageFieldV1 =
  'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'estimatedCostUsd';

/**
 * How complete a usage figure is: `complete` (every turn measured), `partial` (a lower bound), `live`
 * (a turn is running), `none` (nothing observed yet).
 */
export type UsageCompleteness = 'complete' | 'partial' | 'live' | 'none';

/** Token counters. Null means not measured and is shown as "Unknown", never 0. */
export interface UsageCounters {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cache read input tokens. */
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  /** Estimated from provider rates; never a billed amount. */
  estimatedCostUsd: number | null;
  /** Fields whose value is a lower bound. */
  incomplete: UsageFieldV1[];
}

/** Usage of one provider across a task. */
export interface ProviderUsageV1 extends UsageCounters {
  provider: ProviderId;
  label: string;
  sessions: number;
  observedSessions: number;
  activeSessions: number;
  updatedAt: string | null;
  completeness: UsageCompleteness;
  /** Always null: subscription billing is not observable. */
  billedCostUsd: null;
}

/** Usage of one workflow stage on one provider. */
export interface StageUsageV1 extends UsageCounters {
  stage: 'planning' | 'implementation' | 'quality_pass' | 'repair' | 'review' | 'arbitration';
  label: string;
  provider: ProviderId;
  providerLabel: string;
  turns: number;
  failedTurns: number;
  interruptedTurns: number;
  unsettledTurns: number;
  /** Settled turns' time from request to result; null when none has settled. */
  wallMs: number | null;
  /** `wallMs` omits unsettled turns. */
  wallPartial: boolean;
}

/** Human interventions after the first approval. */
export interface InterventionsV1 {
  total: number;
  answers: number;
  authorizations: number;
  assessments: number;
  retries: number;
  rerunChecks: number;
  recoveries: number;
  revisions: number;
  stops: number;
  approvals: number;
  guidance: number;
}

/** The one-line usage figure of a task summary. */
export interface UsageHeadlineV1 {
  /**
   * Every input and output token across providers, counting cache reads and writes once (Codex input
   * includes its cache reads; Claude reports them separately); null when nothing was measured.
   */
  tokens: number | null;
  /** The cache reads included in `tokens`, usually billed at a fraction of other input; null when unmeasured. */
  cachedTokens: number | null;
  estimatedCostUsd: number | null;
  completeness: UsageCompleteness;
  turns: number;
  interventions: number;
}

/** Everything measured about a task's provider use. */
export interface UsageV1 {
  headline: UsageHeadlineV1;
  providers: ProviderUsageV1[];
  stages: StageUsageV1[];
  turns: number;
  failedTurns: number;
  interruptedTurns: number;
  unsettledTurns: number;
  repairAttempts: number;
  interventions: InterventionsV1;
  /** Fixed footnote about token meanings and estimated cost. */
  note: string;
}

// ---------------------------------------------------------------------------------------------------
// Overview

/** Why an attention item needs you. */
export type AttentionKind =
  | 'approval'
  | 'question'
  | 'scope_authorization'
  | 'assessment'
  | 'failed_check'
  | 'review_findings'
  | 'blocked'
  | 'recovery'
  | 'stalled'
  | 'resource_limit'
  | 'plan_ready'
  | 'action_failed';

/** Something waiting for a person, across tasks and planning conversations. */
export interface AttentionItem {
  /** Stable while the reason holds, e.g. `task:<id>:question`. */
  id: string;
  kind: AttentionKind;
  /** Exactly one of `taskId` and `kickoffId` is set. */
  taskId: string | null;
  kickoffId: string | null;
  title: string;
  /** One human sentence. */
  why: string;
  status: PresentationStatus;
  /** The recorded stop reason code, e.g. `CHECK_TIMEOUT`, or null. */
  stopReason: string | null;
  /** When the reason started, when known. */
  since: string | null;
  /** The actions that resolve it; open the task or planning page for forms. */
  actions: ActionView[];
}

/** One task in the overview and sidebar. */
export interface TaskSummaryV1 {
  id: string;
  title: string;
  repository: RepositoryView;
  status: PresentationStatus;
  /** E.g. "File approval needed", "Working", "Delivered locally". */
  statusLabel: string;
  /** The current workflow stage, e.g. "Validate". */
  stageLabel: string;
  /** 1-based slice position. */
  slice: { index: number; count: number };
  implementer: ProviderView;
  reviewer: ProviderView;
  lastActivityAt: string | null;
  stalled: StallV1 | null;
  usage: UsageHeadlineV1;
  needsAttention: boolean;
}

/** One planning conversation that has not become a task yet. */
export interface KickoffSummaryV1 {
  id: string;
  title: string;
  repository: RepositoryView;
  status: PresentationStatus;
  statusLabel: string;
  provider: ProviderView;
  lastActivityAt: string | null;
  needsAttention: boolean;
}

/** A verified local commit (or proven no-change delivery). */
export interface RecentDeliveryV1 {
  taskId: string;
  taskTitle: string;
  /** 1-based. */
  slice: { index: number; count: number };
  /** Null for a no-change delivery. */
  commit: string | null;
  outcome: 'committed' | 'no_change';
  deliveredAt: string;
  /** E.g. "Validation and acceptance verified by Grampus; independent review by Claude". */
  evidence: string;
}

/** `GET /api/v1/overview`: the home screen. */
export interface OverviewV1 {
  apiVersion: ApiVersion;
  /** Journal revision this was computed from. */
  revision: string;
  application: {
    name: string;
    version: string;
    channel: string;
    build: { id: string; builtAt: string } | null;
    journal: string;
  };
  health: HealthSummaryV1;
  /**
   * The guided runner pool: tasks that own a runner (including owners kept for recovery), the
   * `maxConcurrentTasks` limit and the owning task ids. While `running >= limit`, actions that start
   * work are disabled and their routes answer 409 `pool_full`; nothing is queued.
   */
  pool: { running: number; limit: number; owners: string[] };
  /** Everything needing you, most urgent first. */
  attention: AttentionItem[];
  tasks: TaskSummaryV1[];
  planning: KickoffSummaryV1[];
  /** Latest first, bounded. */
  recentDeliveries: RecentDeliveryV1[];
  /** Available quality passes for revision forms and the new-task screen. */
  qualityPasses: { id: string; title: string; kind: 'lens' | 'edit' }[];
}

// ---------------------------------------------------------------------------------------------------
// Task detail

/** What happens next: automatically, by you, or nothing. */
export type NextStepV1 =
  | { kind: 'automatic'; label: string }
  | { kind: 'human'; label: string; actionIds: ActionId[] }
  | { kind: 'none'; label: string };

/** A lens or other sub-result inside a workflow stage. */
export interface StageItemView {
  id: string;
  label: string;
  state: StageState;
  evidence: EvidenceSource | null;
  detail: string | null;
}

/** One step of the workflow strip. Stages come from data: edit passes and lenses are configurable. */
export interface StageView {
  /** `plan`, `implement`, `quality:<pass id>`, `validate`, `review`, `accept` or `deliver`. */
  id: string;
  kind: 'plan' | 'implement' | 'quality_pass' | 'readiness' | 'validate' | 'review' | 'accept' | 'deliver';
  label: string;
  state: StageState;
  /** Who established the result shown; null while nothing is recorded. */
  evidence: EvidenceSource | null;
  detail: string | null;
  /** The review's lens assessments; empty for other stages. */
  items: StageItemView[];
}

/** What is running now. No percentages: only what is known. */
export interface ActivityV1 {
  /** E.g. "Implementing the change". */
  title: string;
  description: string;
  actor: 'implementer' | 'reviewer' | 'arbitrator' | 'check' | 'controller';
  provider: ProviderView | null;
  stageLabel: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  repositoryCalls: number | null;
  integrationCalls: number | null;
  fileRequests: number | null;
  /** Latest agent requests, e.g. "Read src/app.ts"; describes what was asked, not results. */
  recent: string[];
}

/** Coverage of one acceptance criterion. */
export interface CriterionView {
  text: string;
  /** `passed`: acceptance verified on the current artifact or a delivered slice. */
  state: StageState;
  evidence: EvidenceSource | null;
}

/** One check, preparation or acceptance run, without its raw output. */
export interface CheckView {
  id: string;
  name: string;
  /** "Preparation", "Validation" or "Acceptance". */
  purposeLabel: string;
  state: StageState;
  /** E.g. "Passed", "Failed", "Running", "Needs recovery". */
  stateLabel: string;
  evidence: EvidenceSource | null;
  /** Compact failure summary (assertion, diagnostics); null unless failed. */
  issue: string | null;
  error: string | null;
  exitCode: number | null;
  reason: string | null;
  command: { file: string; args: string[] };
  timeoutMs: number;
  stdoutCharacters: number | null;
  stderrCharacters: number | null;
  outputTruncated: boolean;
  outputUnavailable: boolean;
  /** GET this with `&stream=stdout|stderr&offset=<n>` for 16,000-character pages. */
  outputPath: string;
}

/** One review finding. */
export interface FindingView {
  severity: 'blocking' | 'suggestion';
  description: string;
  evidence: string;
}

/** The reviewer's assessment of one selected lens and what was recorded for it. */
export interface LensView {
  id: string;
  title: string;
  verdict: 'pass' | 'fail' | null;
  summary: string | null;
  findings: FindingView[];
  /** The recorded quality evidence for the current attempt. */
  recorded: { outcome: 'passed' | 'failed' | 'skipped'; evidence: EvidenceSource } | null;
}

/** One local commit delivered by this task. */
export interface CommitView {
  /** 1-based slice. */
  slice: number;
  commit: string | null;
  outcome: 'committed' | 'no_change';
}

/** Results so far. */
export interface ResultsV1 {
  criteria: CriterionView[];
  checks: CheckView[];
  /** Heading for the findings, e.g. "Earlier review findings to address". */
  findingsTitle: string;
  findings: FindingView[];
  lenses: LensView[];
  qualityEdits: { id: string; title: string; changed: boolean }[];
  commits: CommitView[];
  /** Open problems, one sentence each. */
  unresolved: string[];
}

/** One acceptance check of a slice and what it must observe. */
export interface PlanAcceptanceView {
  name: string;
  file: string;
  args: string[];
  timeoutMs: number;
  expectedStdout: string | null;
  /** Additional observations as formatted JSON, or null. */
  expectations: string | null;
}

/** One slice of the plan. */
export interface PlanSliceView {
  title: string;
  approach: string | null;
  criteria: string[];
  files: { edit: string[]; create: string[]; delete: string[] };
  preparation: { name: string; file: string; args: string[]; timeoutMs: number } | null;
  /** Explicit read-only mechanical checks, run before behavioural validation in this order. */
  readiness: { kind: 'format' | 'lint' | 'types'; name: string; file: string; args: string[]; timeoutMs: number }[];
  validation: { name: string; file: string; args: string[]; timeoutMs: number };
  /** The acceptance checks in the order they run; at least one. */
  acceptance: PlanAcceptanceView[];
  delivery: { mode: 'commit' | 'no_change'; message: string };
}

/** The plan as it is (or will be) approved. */
export interface PlanView {
  /** Effective fixed role assignments shown before approval, including inherited editing choices. */
  modelAssignments?: { role: string; provider: string; model: string | null; effort: string | null }[];
  profileName?: string | null;
  /** Complete controller-normalised plan for exact inspection, never reconstructed by the client. */
  rawPlan: string;
  title: string;
  outcome: string;
  approach: string;
  criteria: string[];
  repository: RepositoryView;
  base: string;
  workspace: { adapter: 'git' | 'orca'; path: string | null };
  implementer: ProviderView;
  reviewer: ProviderView;
  mode: 'automatic' | 'supervised';
  /** One paragraph on the workflow policy. */
  workflowSummary: string;
  /** One paragraph on review repairs and arbitration. */
  reviewSummary: string;
  qualityPasses: { id: string; title: string; kind: 'lens' | 'edit'; instructions: string }[];
  qualitySummary: string;
  context: { files: string[]; totalFiles: number; exploration: boolean };
  preparation: { name: string; file: string; args: string[]; timeoutMs: number } | null;
  /** A revised plan keeps the workspace files of an earlier version; its checks and reviews run again. */
  revision: { previousVersion: number; artifact: string } | null;
  slices: PlanSliceView[];
}

/** File contents to inspect before authorizing, present only while authorization is pending. */
export interface ScopeView {
  files: { path: string; content: string | null; action: 'edit' | 'create' | 'delete' }[];
  instructions: { path: string; content: string }[];
  /** Why authorization cannot be prepared; authorization is disabled while set. */
  error: string | null;
}

/** One timeline entry. */
export interface TimelineEntryV1 {
  /** Journal sequence; also the paging cursor. */
  sequence: number;
  at: string;
  type: string;
  /** E.g. "Validation started", "Stopped: check timed out". */
  summary: string;
  /** The event's note in UI language, bounded; null when none. */
  note: string | null;
  reasonCode: string | null;
}

/** `GET /api/v1/tasks/:id/timeline?cursor=&limit=`: newest first. */
export interface TimelinePageV1 {
  apiVersion: ApiVersion;
  taskId: string;
  total: number;
  entries: TimelineEntryV1[];
  /** Pass as `cursor` for the next older page; null at the beginning of the history. */
  nextCursor: number | null;
}

/** Reference material and digests, loaded on demand where large. */
export interface DetailsV1 {
  approval: { version: number; digest: string; approved: boolean };
  artifact: { artifact: string | null; instructionsDigest: string | null; head: string | null };
  /** Changed paths in the retained snapshot; contents through `changesPath`. */
  changes: string[];
  /** GET with `?path=<changed path>` for one file's before and after. */
  changesPath: string;
  plan: PlanView;
  scope: ScopeView | null;
  references: { label: string; path: string; files: number; base: string | null }[];
  workspace: { path: string | null; adapter: 'git' | 'orca' };
  exploration: { calls: number; readFiles: string[] };
  timeline: { total: number; recent: TimelineEntryV1[]; path: string };
  reportPath: string;
}

/** A configured MCP connection seen by the current agent session. */
export interface McpServerV1 {
  name: string;
  status: string;
  tools: number | null;
}

/** `GET /api/v1/tasks/:id`. */
export interface TaskDetailV1 {
  apiVersion: ApiVersion;
  revision: string;
  id: string;
  /** Navigation and display failures of the optional Orca desktop, never workflow evidence. */
  orca: { open: ActionView; problem: string | null } | null;
  header: {
    title: string;
    /** Markdown. */
    outcome: string;
    repository: RepositoryView;
    slice: { index: number; count: number; title: string };
    status: PresentationStatus;
    statusLabel: string;
    /** One sentence. */
    explanation: string;
    /** The controller's note in UI language (command names replaced), bounded; Markdown. */
    note: string | null;
    stopReason: { code: string; at: string } | null;
    nextStep: NextStepV1;
    stalled: StallV1 | null;
    /** The last dashboard action that failed for this task, while still relevant. */
    actionError: { action: string; message: string; at: string | null } | null;
    mode: 'automatic' | 'supervised';
    stale: boolean;
  };
  workflow: StageView[];
  activity: ActivityV1 | null;
  /** Every action available now, primary first. Attention actions are a subset. */
  decisions: ActionView[];
  /** Read-only live workspace observations, independent of journal revision. Null before setup. */
  liveChangesPath: string | null;
  /** Configured interval between live observations while this task is visible. */
  liveChangesIntervalMs: number;
  /** Shared allowance and recent decisions for the current slice. */
  repairs: RepairsV1;
  /** The approved task-wide dispatch allowance, rendered from the same ledger as the controller gate. */
  spending: SpendingV1;
  /** Bounded human proposals and their assignment history; none changes the approved plan. */
  guidance: GuidanceV1;
  results: ResultsV1;
  usage: UsageV1;
  details: DetailsV1;
  integrations: McpServerV1[];
}

/** `GET /api/v1/tasks/:id/changes?path=`: one retained change. */
export interface ChangeV1 {
  apiVersion: ApiVersion;
  path: string;
  before: { content: string | null; encoding: string };
  after: { content: string | null; encoding: string };
}

/** A display-only observation of a changing workspace, never evidence for a workflow gate. */
export interface LiveChangesV1 {
  apiVersion: ApiVersion;
  observedAt: string;
  base: string;
  paths: string[];
  total: number;
  truncated: boolean;
  selected: { path: string; patch: string; truncated: boolean } | null;
}

/** The controller's recorded reasoning and budget at each repair decision. */
export interface RepairDecisionV1 {
  sequence: number;
  at: string;
  title: string;
  /** Bounded check diagnostics or concrete blocking findings, quoted as display-only text. */
  trigger: string;
  reason: string;
  progress: string;
  budget: string;
  resultId: string;
  artifact: string | null;
  /** Controller-observed results after this decision, bounded to its next attempt. */
  results: { name: string; outcome: string; artifact: string | null }[];
  outcome: string;
}

/** Remaining automatic repair allowance; explicit manual retries remain separate decisions. */
export interface RepairsV1 {
  used: number;
  allowance: number;
  remaining: number;
  readiness: { used: number; allowance: number; remaining: number; checks: number };
  decisions: RepairDecisionV1[];
}

/** Human guidance shown literally with controller-established queue/assignment state. */
export interface GuidanceMessageV1 {
  id: string;
  text: string;
  at: string;
  version: number;
  slice: number;
  targetLabel: string;
  status: 'queued' | 'assigned' | 'cancelled' | 'expired' | 'unknown';
  statusLabel: string;
  detail: string;
  cancel: ActionView | null;
}

/** Current queue, recent history and the action to add guidance without starting a turn. */
export interface GuidanceV1 {
  /** Preserves drafts across stage changes, but never across approved versions or slices. */
  draftKey: string;
  compose: ActionView | null;
  messages: GuidanceMessageV1[];
}

/** Display text for a task-wide allowance; active turns may overshoot token thresholds. */
export interface SpendingV1 {
  status: 'available' | 'turn_limit' | 'token_limit' | 'usage_unknown';
  statusLabel: string;
  turnsLabel: string;
  tokensLabel: string;
  explanation: string;
  note: string;
}

// ---------------------------------------------------------------------------------------------------
// Planning conversation detail

/** One message of the planning discussion. */
export interface KickoffMessageV1 {
  role: 'user' | 'planner';
  /** "You" or the provider's name. */
  author: string;
  at: string;
  kind: 'message' | 'answers' | 'proposal';
  /** Markdown. Answers are listed one per line; a proposal is described, not dumped as JSON. */
  text: string;
}

/** One pending planner question. */
export interface QuestionView {
  id: string;
  /** Markdown, inline. */
  prompt: string;
  suggestions: string[];
}

/** Activity states describe observations, never acceptance or recovery evidence. */
export type ActivityStatusV1 = 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'observed';

/** A stable participant in the task network. Models are separate from their provider agents. */
export interface ActivityNodeV1 {
  id: string;
  kind: 'controller' | 'agent' | 'model' | 'tools' | 'check' | 'delivery';
  label: string;
  detail: string;
  /** Current recorded state, used only in live mode, never to seed historical replay. */
  status: ActivityStatusV1;
  /** Server-defined aggregation for the compact network; expanded history retains individual sessions. */
  groupId?: string;
  groupLabel?: string;
  /** False for configured endpoints without a recorded connection or call. */
  recorded?: boolean;
  /** A relationship established by recorded session/tool activity, retained when its events leave the window. */
  parentId?: string;
}

/** A normalised event retaining its original journal identity and explicit endpoint semantics. */
export interface ActivityEventV1 {
  id: string;
  cursor: string;
  at: string;
  type: string;
  category: 'controller' | 'model' | 'tool' | 'review' | 'validation' | 'delivery' | 'failure';
  source: string;
  target: string;
  label: string;
  status: ActivityStatusV1;
  provenance: 'observed' | 'inferred';
  preview: string | null;
  durationMs: number | null;
  correlation: {
    taskId: string | null;
    version: number | null;
    executionId: string | null;
    sessionId: string | null;
    runId: string | null;
    providerTurnId: string | null;
    itemId: string | null;
    resultId: string | null;
    attemptId: string | null;
    workspaceId: string | null;
    sliceIndex: number | null;
    artifact: string | null;
    messageId: string | null;
    requestId: string | null;
    parentItemId: string | null;
    providerSessionId: string | null;
    provider: 'codex' | 'claude' | null;
  };
  /** Server-decided state changes. The client only folds these for replay. */
  updates: { nodeId: string; status: ActivityStatusV1; label?: string; onlyIfActive?: boolean }[];
  /** Provider counters retain their scope; snapshots must never be summed as per-call token costs. */
  usage: { input: number | null; output: number | null; cached: number | null; scope: string } | null;
}

/** The owner of a graph and its replay, including planning before a task exists. */
export interface ActivitySubjectV1 {
  kind: 'task' | 'planning';
  id: string;
}

/** A bounded, chronological activity window from the existing journals. */
export interface ObservabilityV1 {
  apiVersion: ApiVersion;
  subject: ActivitySubjectV1;
  revision: string;
  intervalMs: number;
  nodes: ActivityNodeV1[];
  events: ActivityEventV1[];
  /** Fetch the preceding window with `?before=`. No cursor means the latest window. */
  before: string | null;
  coverage: string[];
}

/** `GET /api/v1/kickoffs/:id`. */
export interface KickoffDetailV1 {
  apiVersion: ApiVersion;
  revision: string;
  id: string;
  title: string;
  status: PresentationStatus;
  statusLabel: string;
  explanation: string;
  request: string;
  repository: RepositoryView;
  base: string;
  provider: ProviderView;
  adapter: 'git' | 'orca';
  messages: KickoffMessageV1[];
  questions: QuestionView[];
  proposal: { digest: string; plan: PlanView } | null;
  context: {
    exploration: boolean;
    files: string[];
    totalFiles: number | null;
    inventoryDigest: string | null;
    directories: { path: string; files: number }[];
  };
  references: { label: string; path: string; files: number; base: string | null }[];
  referenceSuggestions: { path: string; reason: string }[];
  activity: ActivityV1 | null;
  /** Planning measurements from the session journal, including live observations. */
  usage: UsageV1;
  exploration: { calls: number; readFiles: string[] };
  integrations: McpServerV1[];
  error: string | null;
  /** The last dashboard action for this conversation that failed in its worker, while still shown. */
  actionError: { action: string; message: string; at: string | null } | null;
  /** Set once the proposal became a task; open that task instead. */
  taskId: string | null;
  actions: ActionView[];
}

// ---------------------------------------------------------------------------------------------------
// Lookups and actions outside /api/v1/
//
// The client reads these unversioned routes for work that is not a view: repository inspection and file
// search before a planning conversation exists, reference suggestions, paged check output, the report,
// creating a planning conversation or importing a plan, and every action (`ActionView.request`).

/** `POST /api/repositories/inspect` with `{ repo, request? }`: the pinned commit and suggested starting files. */
export interface InspectRepositoryResponse {
  /** The repository's top level, resolved. */
  repo: string;
  /** The pinned commit; send it back as `base` when creating the planning conversation. */
  base: string;
  context: {
    inventoryDigest: string;
    digest: string;
    totalFiles: number;
    totalBytes: number;
    includedFiles: number;
    omittedFiles: number;
    bytes: number;
    /** Suggested starting paths. */
    selected: string[];
    directories: { path: string; files: number }[];
  };
}

/** `POST /api/repositories/files` with `{ repo, base, query?, offset? }`: one page of the pinned inventory. */
export interface FileSearchResponse {
  files: { path: string; oid: string; bytes: number }[];
  matches: number;
  offset: number;
  /** Null on the last page. */
  nextOffset: number | null;
  inventoryDigest: string;
}

/** `POST /api/references/suggest` with `{ request }`: folders mentioned in the description. */
export interface ReferenceSuggestionsResponse {
  suggestions: { path: string; reason: string }[];
}

/**
 * `GET /api/v1/orca-worktrees`: local Orca worktrees New task offers as repository folders, grouped by
 * repository. Choosing one only fills the folder field; nothing is decided from this list.
 */
export interface OrcaWorktreesV1 {
  apiVersion: ApiVersion;
  /** False when the dashboard has no Orca client or Orca did not answer; the choice is then not offered. */
  available: boolean;
  repositories: { name: string; worktrees: { path: string; label: string }[] }[];
  /** Worktrees past the display bound: counted, not listed. */
  omitted: number;
}

/** `POST /api/kickoffs` (201) and `POST /api/tasks` (201), and a reset (200): the new record. */
export interface CreatedResponse {
  id: string;
}

/** An action accepted by the server: 202 when a worker runs it, 200 when it settled at once. */
export interface AcceptedResponse {
  ok: true;
  /**
   * Only on approving an automatic plan while the runner pool is full (200): the approval stands, no
   * worker was started and nothing is queued. The task waits as ready for an explicit Continue.
   */
  started?: false;
}

/** `GET /api/tasks/:id/report`: the Markdown report built from the journal. */
export interface ReportResponse {
  report: string;
}

/** `GET <CheckView.outputPath>&stream=&offset=`: one page of retained check output, control characters removed. */
export interface CheckOutputPage {
  checkId: string;
  stream: 'stdout' | 'stderr';
  content: string;
  offset: number;
  /** Null when this page reaches the end. */
  nextOffset: number | null;
  totalCharacters: number;
  /** Only the journal's bounded preview was available. */
  incomplete: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Errors

/** Machine-readable error categories, mapped from the error class in `server/errors.ts`. */
export type ErrorCodeV1 =
  | 'invalid_request'
  | 'refused'
  | 'unauthorized'
  | 'forbidden_origin'
  | 'not_found'
  | 'stale_state'
  | 'pool_full'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unavailable';

/** Every non-2xx API response, under `/api/v1/` and on the lookup and action routes alike. */
export interface ErrorV1 {
  error: {
    status: number;
    code: ErrorCodeV1;
    message: string;
    /** Field-level problems of an invalid request. */
    issues?: string[];
  };
}

// Model and comparison DTOs remain available through this single public contract.
export type {
  ReasoningEffortV1,
  ModelAssignmentV1,
  ModelProfileV1,
  ModelProfilesV1,
  ProviderModelsV1,
  ModelMetricsV1,
  RunMetricsV1,
  ComparisonSummaryV1,
  ComparisonV1,
  IntegrationPreviewV1,
} from './model-api-types.js';
