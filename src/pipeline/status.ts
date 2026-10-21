// A task's status for people and chat agents: where it is, what needs the user and the evidence so far.
// Derived only from the folded log, so it never disagrees with what the driver acts on.
import type { CommandKind } from '../domain/events.js';
import { currentDispatch, type TaskState } from './state.js';

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
  finished: { outcome: string; sha: string | null; override: boolean } | null;
  lastStop: { reason: string; at: string } | null;
  /** The most recent refused command, if it came after the last applied one. */
  refused: { kind: string; reason: string; at: string } | null;
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
      ? { outcome: state.finished.outcome, sha: state.finished.sha, override: state.finished.override }
      : null,
    lastStop: state.lastStop,
    refused: latestRefusal(state),
  };
}

function latestRefusal(state: TaskState): TaskSummary['refused'] {
  const refused = state.refusals.at(-1);
  const applied = [...state.commands].reverse().find(command => command.kind !== 'reply');
  return refused && (!applied || refused.at > applied.at) ? refused : null;
}

function phaseOf(state: TaskState): string {
  if (state.finished) return `${state.finished.outcome}${state.finished.override ? ' (with unresolved problems)' : ''}`;
  if (state.attention) return `needs you: ${state.attention.reason}`;
  for (const record of [...state.stages.values()].reverse()) {
    const dispatch = currentDispatch(record);
    if (dispatch && !dispatch.settled && !dispatch.exited)
      return record.stage === 'spec'
        ? `${record.key} running (discuss it in the worker's Orca chat)`
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
