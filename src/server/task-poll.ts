// Owns the dashboard's polling view of one guided task: the controller's task view, compacted so a poll
// never serialises full file inventories, raw check output, delivery snapshots or the report.
import { z } from 'zod';
import type { Store, JournalEvent } from '../persistence/store.js';
import { guidedTaskView } from '../orchestration/guided-status.js';
import { serverLimits } from '../config/limits.js';
import { checkIssue, outputExcerpt } from '../verification/check-output.js';
import type { RepositoryCheck } from '../persistence/records.js';
import { guidedSnapshot } from '../orchestration/guided/snapshots.js';
import { pendingScopeFiles } from './view-model/scope.js';

const noteSchema = z.object({ note: z.string() });

/** An event as polls show it: only a bounded, plain excerpt of its note. */
export function eventSummary(event: JournalEvent) {
  return {
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    data: {
      note: outputExcerpt(noteSchema.safeParse(event.data).data?.note ?? '', serverLimits.eventNoteCharacters),
    },
  };
}

function checkSummary(check: RepositoryCheck) {
  return {
    id: check.id,
    executionId: check.executionId,
    purpose: check.purpose,
    spec: check.spec,
    phase: check.phase,
    error: check.error,
    toolPid: check.toolPid,
    supervisorPid: check.supervisorPid,
    dispatch: check.dispatch,
    issue: check.phase === 'failed' ? checkIssue(check) : null,
    result: check.result
      ? {
          reason: check.result.reason,
          exitCode: check.result.exitCode,
          outputTruncated: check.result.outputTruncated,
          outputUnavailable: check.result.outputUnavailable,
          stdoutCharacters: check.result.stdout.length,
          stderrCharacters: check.result.stderr.length,
        }
      : null,
  };
}

/** The compact polling view of a task, ready to serialise. Its shape follows `guidedTaskView`. */
export function taskPoll(store: Store, id: string): object {
  const view = guidedTaskView(store, id);
  const snapshot = guidedSnapshot(store, view.state);
  const scope = pendingScopeFiles(view.state, view.workspace?.path ?? null, snapshot);
  const historyChecks = store
    .executions()
    .filter(
      execution =>
        execution.taskId === view.task.id &&
        execution.version === view.state.version &&
        execution.sliceIndex === view.state.sliceIndex,
    )
    .flatMap(execution => store.checks(execution.id));
  const failed = historyChecks.findLast(check => check.phase === 'failed');
  const note =
    view.state.note.length > serverLimits.stateNoteSummaryThreshold && failed
      ? `Check ${failed.spec.name} failed.\n${checkIssue(failed)}\nRetained check: ${failed.id}`
      : outputExcerpt(view.state.note, serverLimits.stateNoteCharacters);
  const compactState = {
    ...view.state,
    note,
    feedback: '',
    // The dashboard shows the retained changes and instructions, never the file inventory or index.
    snapshot: snapshot
      ? {
          ...view.state.snapshot,
          diff: snapshot.diff,
          instructions: snapshot.instructions,
        }
      : null,
  };
  const events = store.events(id);
  return {
    ...view,
    state: compactState,
    task: { ...view.task, guided: compactState },
    checks: historyChecks.map(checkSummary),
    implementations: view.implementations.map(run => ({ id: run.id, phase: run.phase, error: run.error })),
    deliveries: view.deliveries.map(delivery => ({ ...delivery, request: null })),
    scopeFiles: scope.files,
    scopeError: scope.error,
    eventCount: events.length,
    events: events.slice(-serverLimits.recentEvents).map(eventSummary),
    report: null,
  };
}
