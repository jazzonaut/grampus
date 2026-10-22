// A task's status for people and chat agents: where it is, what needs the user and the evidence so far.
// Derived from the folded log (plus the spec file it names), so it never disagrees with what the driver
// acts on. An approval request carries the spec itself: nobody should be asked to approve unseen text.
import { existsSync, readFileSync } from 'node:fs';
import { specLimits } from '../config/limits.js';
import type { CheckResult, CommandKind, GuardResult } from '../domain/events.js';
import type { Finding } from '../domain/review.js';
import { currentDispatch, type ReviewRecord, type TaskState } from './state.js';

export interface TaskSummary {
  taskId: string;
  title: string;
  recipe: string;
  worktree: string | null;
  /** One line: finished, needs you, a running stage, or waiting for the driver. */
  phase: string;
  needsYou: { reason: string; detail: string; options: CommandKind[]; since: string } | null;
  questions: { messageId: string; stage: string | null; text: string; at: string }[];
  spec: { version: number; path: string; checks: string[] } | null;
  rounds: { round: number; checks: string; review: string; decision: string | null }[];
  finished: { outcome: string; sha: string | null; override: boolean; at: string } | null;
  lastStop: { reason: string; at: string } | null;
  /** The most recent refused command, if it came after the last applied one. */
  refused: { kind: string; reason: string; at: string } | null;
  /** While a spec version awaits approval: its text and its review, to show before asking. */
  approval: { version: number; text: string; review: string[] } | null;
  /** While a round awaits accept, continue or abandon: the evidence behind it, to show before asking. */
  result: { round: number; lines: string[] } | null;
}

export function summarise(state: TaskState): TaskSummary {
  const latest = state.specs.at(-1);
  return {
    taskId: state.taskId,
    title: state.title,
    recipe: state.recipe.name,
    worktree: state.workspace?.path ?? null,
    phase: phaseOf(state),
    needsYou: state.attention,
    questions: [...state.questions]
      .filter(([, question]) => !question.answered)
      .map(([messageId, question]) => ({
        messageId,
        stage: question.key,
        text: question.body || question.subject,
        at: question.at,
      })),
    spec: latest
      ? {
          version: latest.version,
          path: latest.path,
          checks: latest.checks.map(check => `${check.name}: ${check.command}`),
        }
      : null,
    rounds: [...state.verify.entries()].map(([round, verify]) => {
      const review = state.reviews.get(round);
      return {
        round,
        checks: `${verify.results.filter(result => result.passed).length}/${verify.results.length} pass at ${verify.sha.slice(0, 12)}`,
        review: review
          ? review.report
            ? `${review.report.verdict}, ${review.blocking.length} blocking`
            : `unavailable: ${review.error}`
          : 'none',
        decision: state.decisions.get(round)?.decision ?? null,
      };
    }),
    finished: state.finished
      ? {
          outcome: state.finished.outcome,
          sha: state.finished.sha,
          override: state.finished.override,
          at: state.finished.at,
        }
      : null,
    lastStop: state.lastStop,
    refused: latestRefusal(state),
    approval: approvalOf(state),
    result: resultOf(state),
  };
}

function approvalOf(state: TaskState): TaskSummary['approval'] {
  const latest = state.specs.at(-1);
  if (!latest || state.attention?.reason !== `approve-spec:${latest.version}`) return null;
  const full = existsSync(latest.path)
    ? readFileSync(latest.path, 'utf8')
    : `(the spec file ${latest.path} is missing)`;
  const text =
    Buffer.byteLength(full) > specLimits.shownBytes
      ? `${Buffer.from(full).subarray(0, specLimits.shownBytes).toString('utf8')}\n[... cut; the full spec is ${latest.path}]`
      : full;
  const reviewed = state.specReviews.get(latest.version);
  const reviewRunning = !reviewed && state.stages.has(`spec-review:${latest.version}`);
  const review = !reviewed
    ? [reviewRunning ? 'spec review: still running; its findings are added here when it finishes' : 'no spec review']
    : reviewed.report
      ? [
          `spec review: ${reviewed.report.verdict}. ${reviewed.report.summary}`,
          ...reviewed.report.findings.map(
            finding => `- ${finding.severity}: ${finding.title}${finding.detail ? ` (${finding.detail})` : ''}`,
          ),
        ]
      : [`spec review unavailable: ${reviewed.error ?? 'unknown'}`];
  return { version: latest.version, text, review };
}

/** The evidence for the round awaiting the user: commits, files, checks, guard and review. */
function resultOf(state: TaskState): TaskSummary['result'] {
  const match = /^(ready|escalate):(\d+)$/.exec(state.attention?.reason ?? '');
  if (!match) return null;
  const round = Number(match[2]);
  // The reasons are not repeated here: the attention detail already lists them.
  const lines = [
    ...guardLines(state.guard.get(round)?.guard),
    ...(state.verify.get(round)?.results ?? []).map(checkLine),
    ...reviewLines(state.reviews.get(round)),
  ];
  return { round, lines };
}

function guardLines(guard: GuardResult | undefined): string[] {
  if (!guard) return [];
  const files = guard.changedFiles.slice(0, shownFiles).join(', ');
  const more = guard.changedFiles.length > shownFiles ? ` and ${guard.changedFiles.length - shownFiles} more` : '';
  return [
    `${guard.commits} commit${guard.commits === 1 ? '' : 's'}; changed: ${files || 'nothing'}${more}`,
    ...guard.violations.map(violation => `integrity problem: ${violation}`),
    ...(guard.modifiedTests.length ? [`existing tests modified: ${guard.modifiedTests.join(', ')}`] : []),
    ...(guard.modifiedCheckConfig?.length
      ? [`check configuration changed: ${guard.modifiedCheckConfig.join(', ')}`]
      : []),
  ];
}

function checkLine(result: CheckResult): string {
  const outcome = result.timedOut
    ? 'TIMED OUT'
    : !result.passed
      ? 'FAILED'
      : result.flaky
        ? 'passed on rerun (flaky)'
        : 'passed';
  return `check ${result.name}: ${outcome} (${result.command})`;
}

function reviewLines(review: ReviewRecord | undefined): string[] {
  if (!review) return ['no review in this recipe'];
  if (!review.report) return [`review unavailable: ${review.error ?? 'unknown'}`];
  const where = (finding: Finding) => `${finding.file ?? '?'}:${finding.line ?? '?'}`;
  return [
    `review: ${review.report.verdict}. ${review.report.summary}`,
    ...review.blocking.map(finding =>
      `- blocking: ${finding.title} (${where(finding)}) ${finding.scenario ?? ''}`.trimEnd(),
    ),
    ...review.report.findings
      .filter(finding => finding.severity === 'note')
      .map(finding => `- note: ${finding.title}${finding.detail ? ` (${finding.detail})` : ''}`),
    ...review.downgraded.map(finding => `- unsupported blocker, kept as a note: ${finding.title}`),
  ];
}

/** Changed files listed with a result before the rest are counted. */
const shownFiles = 15;

function latestRefusal(state: TaskState): TaskSummary['refused'] {
  const refused = state.refusals.at(-1);
  const applied = [...state.commands].reverse().find(command => command.kind !== 'reply');
  return refused && (!applied || refused.at > applied.at) ? refused : null;
}

function phaseOf(state: TaskState): string {
  if (state.finished)
    return `${state.finished.outcome}${state.finished.override ? ' (with unresolved problems)' : ''}${
      state.merged ? `, merged into ${state.merged.branch}` : ''
    }`;
  if (state.attention) return `needs you: ${state.attention.reason}`;
  for (const record of [...state.stages.values()].reverse()) {
    const dispatch = currentDispatch(record);
    if (dispatch && !dispatch.settled && !dispatch.exited)
      return record.stage === 'spec'
        ? `${record.key} running (its questions come to you through Grampus)`
        : `${record.key} running`;
  }
  return 'waiting for the driver';
}

/** Plain-text rendering for the terminal and chat agents. */
export function renderSummary(summary: TaskSummary): string {
  const lines = [`${summary.taskId}  ${summary.title}`, `  recipe: ${summary.recipe}   ${summary.phase}`];
  if (summary.worktree) lines.push(`  worktree: ${summary.worktree}`);
  if (summary.needsYou)
    lines.push(`  NEEDS YOU: ${summary.needsYou.detail}`, `    options: ${summary.needsYou.options.join(', ')}`);
  if (summary.approval)
    lines.push(
      `  ----- spec v${summary.approval.version} (show this to the user before they decide) -----`,
      summary.approval.text.trimEnd(),
      '  ----- end of spec -----',
      ...summary.approval.review.map(line => `  ${line}`),
    );
  if (summary.result)
    lines.push(
      `  ----- round ${summary.result.round} result (show this to the user before they decide) -----`,
      ...summary.result.lines.map(line => `  ${line}`),
      '  ----- end of result -----',
    );
  for (const question of summary.questions)
    lines.push(`  QUESTION ${question.messageId} (${question.stage ?? 'worker'}): ${question.text}`);
  if (summary.spec)
    lines.push(
      `  spec v${summary.spec.version}: ${summary.spec.path}`,
      ...summary.spec.checks.map(check => `    check ${check}`),
    );
  for (const round of summary.rounds)
    lines.push(
      `  round ${round.round}: checks ${round.checks}; review ${round.review}${round.decision ? `; ${round.decision}` : ''}`,
    );
  if (summary.refused) lines.push(`  Refused ${summary.refused.kind}: ${summary.refused.reason}`);
  if (summary.lastStop && !summary.finished)
    lines.push(
      `  DRIVER STOPPED: ${summary.lastStop.reason}`,
      `    run \`grampus drive ${summary.taskId}\` in its Orca terminal to resume`,
    );
  return lines.join('\n');
}
