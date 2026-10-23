// Dashboard views of a task, built from the same fold the driver acts on (plus the queued commands it has
// not applied yet), so the dashboard never shows a state the driver would disagree with.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { specLimits } from '../config/limits.js';
import type { StoredEvent, UserCommand } from '../domain/events.js';
import { currentDispatch, isOpen, type StageRecord, type TaskState } from '../pipeline/state.js';
import { builderFailed } from '../pipeline/pipeline.js';
import { summarise } from '../pipeline/status.js';
import type {
  CommandView,
  DispatchView,
  MessageView,
  PipelineStep,
  RoundView,
  SpecView,
  StageView,
  StepState,
  TaskDetail,
  TaskListItem,
  TaskStatus,
} from './types.js';
import { timelineOf } from './timeline.js';

/** The list entry for one task. */
export function listItem(state: TaskState, events: readonly StoredEvent[]): TaskListItem {
  const rounds = [...state.decisions.keys(), ...state.verify.keys()];
  return {
    taskId: state.taskId,
    title: state.title,
    recipe: state.recipe.name,
    repository: { path: state.repoPath, name: basename(state.repoPath) },
    status: statusOf(state),
    phase: summarise(state).phase,
    needsYou: state.attention,
    openQuestions: [...state.questions.values()].filter(isOpen).length,
    round: rounds.length ? Math.max(...rounds) : null,
    createdAt: state.createdAt,
    updatedAt: events.at(-1)?.at ?? state.createdAt,
    finishedAt: state.finished?.at ?? null,
    comparisonId: state.comparisonId,
  };
}

/** Everything the task page shows. `queued` are the task's commands, including ones not applied yet. */
export function taskDetail(
  state: TaskState,
  events: readonly StoredEvent[],
  queued: readonly UserCommand[],
): TaskDetail {
  return {
    ...listItem(state, events),
    request: state.request,
    recipeSnapshot: state.recipe,
    worktree: state.workspace
      ? { path: state.workspace.path, baseSha: state.workspace.baseSha, driverTerminal: state.workspace.driverTerminal }
      : null,
    runId: state.runId,
    pipeline: pipelineOf(state),
    summary: summarise(state),
    specs: specsOf(state),
    messages: messagesOf(state, events),
    stages: [...state.stages.values()].map(stageView),
    testsFirst: state.testsFirst,
    setup: state.setup,
    testBaseline: state.testBaseline,
    specChecks: latestSpecChecks(state),
    baseline: state.baseline,
    rounds: roundsOf(state),
    commands: commandsOf(state, events, queued),
    timeline: timelineOf(events),
    merged: state.merged,
    finished: state.finished,
    lastStop: state.finished ? null : state.lastStop,
    explanations: events.flatMap(event =>
      event.type === 'explanation.recorded'
        ? [
            {
              commandId: event.commandId,
              baseSha: event.baseSha,
              candidateSha: event.candidateSha,
              specVersion: event.specVersion,
              explanation: event.explanation,
              error: event.error,
              at: event.at,
            },
          ]
        : [],
    ),
    answers: state.answers,
  };
}

/** The paths the dashboard may serve for a task: its spec versions and check logs, nothing else. */
export function servableFiles(state: TaskState): Set<string> {
  const runs = [
    ...state.specChecks.values(),
    state.baseline,
    ...state.verify.values(),
    ...[...state.polish.values()].map(record => record.checked),
  ];
  return new Set([
    ...state.setup.results.map(item => item.result.logPath),
    ...state.specs.map(spec => spec.path),
    ...runs.flatMap(run => run?.results.map(result => result.logPath) ?? []),
  ]);
}

function latestSpecChecks(state: TaskState): TaskDetail['specChecks'] {
  const version = state.specs.at(-1)?.version;
  const run = version === undefined ? undefined : state.specChecks.get(version);
  return version !== undefined && run ? { version, ...run } : null;
}

function statusOf(state: TaskState): TaskStatus {
  if (state.finished) return state.finished.outcome;
  if (state.attention || [...state.questions.values()].some(isOpen)) return 'needs-you';
  if (state.lastStop) return 'stopped';
  return 'running';
}

function running(record: StageRecord | undefined): boolean {
  const dispatch = currentDispatch(record);
  return Boolean(dispatch && !dispatch.settled && !dispatch.exited);
}

/** State of a worker stage from its latest dispatch. */
function stageState(record: StageRecord | undefined): StepState {
  if (!record) return 'pending';
  if (record.startFailure) return 'failed';
  const dispatch = currentDispatch(record);
  if (!dispatch) return 'pending';
  if (dispatch.settled) return dispatch.settled.outcome === 'succeeded' ? 'done' : 'failed';
  return dispatch.exited ? 'failed' : 'running';
}

function approvedSpec(state: TaskState): number | null {
  if (state.inherited) return 1;
  const approval = state.commands.findLast(command => command.kind === 'approve');
  return approval?.kind === 'approve' ? approval.specVersion : null;
}

function latestRound(state: TaskState): number | null {
  const rounds = [...state.stages.values()].filter(record => record.stage === 'build' || record.stage === 'repair');
  return rounds.length ? Math.max(...rounds.map(record => record.round)) : null;
}

function step(id: PipelineStep['id'], label: string, state: StepState, detail: string | null = null): PipelineStep {
  return { id, label, state, detail };
}

/** The pipeline strip: one step per stage the recipe runs, with where the task is now. */
export function pipelineOf(state: TaskState): PipelineStep[] {
  const latestSpec = state.specs.at(-1);
  const approved = approvedSpec(state);
  const round = latestRound(state);
  return [
    setupStep(state),
    specStep(state),
    state.recipe.specReview && !state.inherited
      ? specReviewStep(state, latestSpec?.version)
      : step('spec-review', 'Spec review', 'skipped'),
    step(
      'approve',
      'Approve',
      approved !== null ? 'done' : state.attention?.reason.startsWith('approve-spec:') ? 'waiting' : 'pending',
      state.inherited ? 'shared spec' : approved !== null ? `v${approved}` : null,
    ),
    state.recipe.testsFirst || state.inheritedTests?.files.length
      ? step('tests', 'Tests first', state.testsFirst ? 'done' : stageState(state.stages.get('tests:0')))
      : step('tests', 'Tests first', 'skipped'),
    baselineStep(state),
    step('build', 'Build', stageState(state.stages.get('build:0'))),
    verifyStep(state, round),
    state.recipe.review ? reviewStep(state, round) : step('review', 'Review', 'skipped'),
    repairStep(state, round),
    state.recipe.polish ? polishStep(state, round) : step('polish', 'Polish', 'skipped'),
    acceptStep(state),
  ];
}

function polishStep(state: TaskState, round: number | null): PipelineStep {
  const decided = round === null ? null : state.polish.get(round)?.decided;
  if (decided)
    return step(
      'polish',
      'Polish',
      'done',
      decided.outcome === 'noop'
        ? 'no worthwhile change'
        : decided.kept
          ? (decided.report?.summary ?? 'kept')
          : 'discarded',
    );
  if (round === null) return step('polish', 'Polish', 'pending');
  const working = [`polish:${round}`, `polish-review:${round}`].some(key => running(state.stages.get(key)));
  const checking = state.stages.has(`polish:${round}`);
  return step('polish', 'Polish', working || checking ? 'running' : 'pending');
}

function setupStep(state: TaskState): PipelineStep {
  const configured = state.setup.configuration;
  if (!configured) return step('setup', 'Setup', 'pending');
  if (!configured.command) return step('setup', 'Setup', 'skipped', configured.source);
  const last = state.setup.results.at(-1);
  const status =
    last?.result.passed && !last.problems.length
      ? 'done'
      : state.attention?.reason.startsWith('setup-failed:')
        ? 'waiting'
        : 'running';
  return step('setup', 'Setup', status, configured.command.command);
}

function specStep(state: TaskState): PipelineStep {
  const latest = state.specs.at(-1);
  const writing = [...state.stages.values()].filter(record => record.stage === 'spec').at(-1);
  if (writing && running(writing))
    return step('spec', 'Spec', 'running', latest ? `revising v${latest.version}` : null);
  if (state.inherited) return step('spec', 'Spec', 'done', `shared from ${state.inherited.fromTask}`);
  if (latest) return step('spec', 'Spec', 'done', `v${latest.version}`);
  return step('spec', 'Spec', writing ? stageState(writing) : 'pending');
}

function specReviewStep(state: TaskState, version: number | undefined): PipelineStep {
  if (version === undefined) return step('spec-review', 'Spec review', 'pending');
  const review = state.specReviews.get(version);
  if (review) {
    if (!review.report) return step('spec-review', 'Spec review', 'failed', 'unavailable');
    const blocking = review.report.findings.filter(finding => finding.severity === 'blocking').length;
    return step(
      'spec-review',
      'Spec review',
      'done',
      `${review.report.findings.length} findings, ${blocking} blocking`,
    );
  }
  return step('spec-review', 'Spec review', stageState(state.stages.get(`spec-review:${version}`)));
}

function baselineStep(state: TaskState): PipelineStep {
  if (!state.baseline) return step('baseline', 'Baseline', 'pending');
  const passed = state.baseline.results.filter(result => result.passed).length;
  return step('baseline', 'Baseline', 'done', `${passed}/${state.baseline.results.length} pass before the change`);
}

function verifyStep(state: TaskState, round: number | null): PipelineStep {
  const verify = round === null ? undefined : state.verify.get(round);
  if (round === null || !verify) return step('verify', 'Verify', 'pending');
  const guard = state.guard.get(round)?.guard;
  const passed = verify.results.filter(result => result.passed).length;
  const ok = passed === verify.results.length && !guard?.violations.length;
  return step('verify', 'Verify', ok ? 'done' : 'failed', `${passed}/${verify.results.length} checks pass`);
}

function reviewStep(state: TaskState, round: number | null): PipelineStep {
  if (round === null) return step('review', 'Review', 'pending');
  const review = state.reviews.get(round);
  if (!review) return step('review', 'Review', stageState(state.stages.get(`review:${round}`)));
  if (!review.report) return step('review', 'Review', 'failed', 'unavailable');
  return step(
    'review',
    'Review',
    review.blocking.length ||
      review.report.verdict !== 'approve' ||
      review.report.requestCoverage?.verdict !== 'covered' ||
      review.report.coverage?.some(item => item.status === 'unverified')
      ? 'failed'
      : 'done',
    `${review.report.verdict}, ${review.blocking.length} blocking`,
  );
}

function repairStep(state: TaskState, round: number | null): PipelineStep {
  const max = state.recipe.repair.maxRounds;
  if (round === null || round === 0) {
    const decided = round === 0 ? state.decisions.get(0)?.decision : undefined;
    const skipped = state.finished !== null || decided === 'ready' || max === 0;
    return step('repair', 'Repair', skipped ? 'skipped' : 'pending');
  }
  const record = state.stages.get(`repair:${round}`);
  return step('repair', 'Repair', running(record) ? 'running' : 'done', `round ${round} of ${max}`);
}

function acceptStep(state: TaskState): PipelineStep {
  if (state.finished)
    return step(
      'accept',
      'Accept',
      state.finished.outcome === 'accepted' ? 'done' : 'failed',
      state.finished.override ? 'accepted with unresolved problems' : state.finished.outcome,
    );
  const reason = state.attention?.reason ?? '';
  return step('accept', 'Accept', /^(ready|escalate):/.test(reason) ? 'waiting' : 'pending');
}

function specsOf(state: TaskState): SpecView[] {
  const approved = approvedSpec(state);
  return state.specs.map(spec => {
    const text = readBounded(spec.path, specLimits.bytes);
    const reviewed = state.specReviews.get(spec.version);
    const reviewState: SpecView['review']['state'] = reviewed
      ? reviewed.report
        ? 'done'
        : 'unavailable'
      : running(state.stages.get(`spec-review:${spec.version}`))
        ? 'running'
        : 'none';
    return {
      version: spec.version,
      at: spec.at,
      path: spec.path,
      hash: spec.hash,
      checks: spec.checks,
      protected: spec.protected,
      text,
      outcome: text === null ? null : specSection(text, 'Outcome'),
      review: { state: reviewState, report: reviewed?.report ?? null, error: reviewed?.error ?? null },
      approved: approved === spec.version,
    };
  });
}

/**
 * The body of a spec's `## <heading>` section, trimmed, or null when it is missing or empty. The spec
 * writer is asked for this format but may deviate, so a missing section is normal.
 */
export function specSection(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s|^```/.test(line));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
  return body || null;
}

/** A file's text up to a bound, or null when it is missing. */
export function readBounded(path: string, bytes: number): string | null {
  if (!existsSync(path)) return null;
  const buffer = readFileSync(path);
  return buffer.length > bytes
    ? `${buffer.subarray(0, bytes).toString('utf8')}\n[... cut at ${bytes} bytes]`
    : buffer.toString('utf8');
}

function messagesOf(state: TaskState, events: readonly StoredEvent[]): MessageView[] {
  const answers = new Map(
    state.commands.flatMap(command =>
      command.kind === 'reply'
        ? [[command.messageId, { body: command.body, at: command.at, source: command.source }] as const]
        : [],
    ),
  );
  return events.flatMap(event =>
    event.type === 'worker.message'
      ? [
          {
            messageId: event.messageId,
            stage: event.key,
            kind: event.kind,
            subject: event.subject,
            body: event.body,
            at: event.at,
            answered: state.questions.get(event.messageId)?.answered ?? false,
            closed: state.questions.get(event.messageId)?.closed ?? false,
            answer: answers.get(event.messageId) ?? null,
          },
        ]
      : [],
  );
}

function launchField(launch: Record<string, unknown> | null | undefined, name: string): string | null {
  const value = launch?.[name];
  return typeof value === 'string' ? value : null;
}

function stageView(record: StageRecord): StageView {
  return {
    key: record.key,
    stage: record.stage,
    round: record.round,
    createdAt: record.createdAt,
    dispatches: record.dispatches.map((dispatch): DispatchView => ({
      dispatchId: dispatch.dispatchId,
      requestedAt: dispatch.requestedAt,
      startedAt: dispatch.startedAt,
      agent: launchField(dispatch.launch?.effective, 'agent') ?? launchField(dispatch.launch?.requested, 'agent'),
      model: launchField(dispatch.launch?.effective, 'model') ?? launchField(dispatch.launch?.requested, 'model'),
      effort: launchField(dispatch.launch?.effective, 'effort') ?? launchField(dispatch.launch?.requested, 'effort'),
      reused: dispatch.reusedHandle !== null,
      settled: dispatch.settled,
      exited: dispatch.exited,
    })),
    startFailure: record.startFailure ? { state: record.startFailure.state, error: record.startFailure.error } : null,
  };
}

function roundsOf(state: TaskState): RoundView[] {
  const rounds = [...state.stages.values()].filter(record => record.stage === 'build' || record.stage === 'repair');
  return rounds.map(record => {
    const guard = state.guard.get(record.round);
    const review = state.reviews.get(record.round);
    return {
      round: record.round,
      stageKey: record.key,
      guard: guard ? { fromSha: guard.fromSha, sha: guard.sha, result: guard.guard } : null,
      checks: state.verify.get(record.round) ?? null,
      review: review
        ? {
            sha: review.sha,
            report: review.report,
            blocking: review.blocking,
            downgraded: review.downgraded,
            error: review.error,
          }
        : null,
      decision: decisionOf(state, record.round),
      polish: polishOf(state, record.round),
    };
  });
}

function polishOf(state: TaskState, round: number): RoundView['polish'] {
  const polished = state.polish.get(round);
  const key = `polish:${round}`;
  if (!polished && !state.stages.has(key)) return null;
  return { stageKey: key, checked: polished?.checked ?? null, decided: polished?.decided ?? null };
}

function decisionOf(state: TaskState, round: number): RoundView['decision'] {
  const decided = state.decisions.get(round);
  if (!decided) return null;
  const report = decided.reasons.find(reason => reason.startsWith(builderFailed));
  return {
    decision: decided.decision,
    reasons: decided.reasons.filter(reason => reason !== report),
    builderFailure: report?.slice(builderFailed.length) ?? null,
  };
}

function commandText(command: UserCommand): string | null {
  switch (command.kind) {
    case 'revise':
      return command.feedback;
    case 'reply':
      return command.body;
    case 'continue':
      return command.guidance;
    case 'abandon':
      return command.reason ?? null;
    case 'approve':
      return `spec v${command.specVersion}`;
    case 'explain':
      return `candidate ${command.candidateSha.slice(0, 12)}`;
    case 'ask':
      return command.question;
    case 'retry':
    case 'accept':
    case 'decline':
      return null;
  }
}

function commandsOf(state: TaskState, events: readonly StoredEvent[], queued: readonly UserCommand[]): CommandView[] {
  const refused = new Map(
    events.flatMap(event => (event.type === 'command.refused' ? [[event.command.id, event.reason] as const] : [])),
  );
  return queued.map(command => ({
    id: command.id,
    kind: command.kind,
    at: command.at,
    source: command.source,
    text: commandText(command),
    messageId: command.kind === 'reply' ? command.messageId : null,
    state: refused.has(command.id) ? 'refused' : state.applied.has(command.id) ? 'applied' : 'queued',
    reason: refused.get(command.id) ?? null,
  }));
}
