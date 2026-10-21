// Owns approval-bound, slice-wide diagnostic attempts. Reservations precede dispatch and survive repairs.
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { DiagnosticGrammar, DiagnosticSelection } from '../domain/diagnostics.js';
import type { RepositoryCheck } from '../persistence/records.js';
import { diagnosticSelectionSchema } from '../domain/diagnostics.js';

const request = z.object({
  family: z.string(),
  attempt: z.number().int().positive(),
  selection: diagnosticSelectionSchema,
});
const finished = request.extend({ checkId: z.string() });

/** Counts all approved selections of one family together, without depending on mutable worker memory. */
export class DiagnosticBudget {
  constructor(
    private readonly store: Store,
    private readonly implementationId: string,
  ) {}

  private events() {
    const run = this.store.implementation(this.implementationId),
      execution = this.store.execution(run.executionId);
    return this.store
      .executions()
      .filter(
        item =>
          item.taskId === execution.taskId &&
          item.version === execution.version &&
          item.sliceIndex === execution.sliceIndex,
      )
      .flatMap(item =>
        this.store.executionEvents(item.id, [
          'implementation.diagnostic_requested',
          'implementation.diagnostic_finished',
        ]),
      );
  }

  /** Remaining attempts are returned with diagnostics so the agent can plan a bounded investigation. */
  usage(family: string, limit: number) {
    const used = this.events().filter(
      event =>
        event.type === 'implementation.diagnostic_requested' && request.safeParse(event.data).data?.family === family,
    ).length;
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  /** Reserves before dispatch; a crash can spend an attempt but can never replay an uncertain command. */
  reserve(family: string, limit: number, grammar: DiagnosticGrammar, selection: DiagnosticSelection) {
    const run = this.store.implementation(this.implementationId),
      execution = this.store.execution(run.executionId);
    return this.store.transaction(() => {
      if (
        this.store.lease(execution.workspaceId)?.runId !== run.id ||
        run.phase !== 'running' ||
        this.store.session(execution.sessionId).run?.id !== run.id
      )
        throw new Error('Diagnostic reservation requires the active implementation lease');
      const events = this.events();
      const attempts = events.filter(
        event =>
          event.type === 'implementation.diagnostic_requested' && request.safeParse(event.data).data?.family === family,
      ).length;
      if (attempts >= limit)
        throw new Error(
          `Diagnostic budget exhausted for ${family}: ${attempts}/${limit} slice-wide attempts. Inspect retained failures and source before asking for a revised allowance. Final coverage remains mandatory.`,
        );
      const previous = events.findLast(
        event =>
          event.type === 'implementation.diagnostic_finished' && finished.safeParse(event.data).data?.family === family,
      );
      const data = previous ? finished.parse(previous.data) : null;
      const failed = data && this.store.check(data.checkId).phase !== 'passed';
      if (failed && !focusedSelection(grammar, selection, data.selection))
        throw new Error(
          'The previous diagnostic failed. Focus the next run on the failing case or file with the approved parameters/files; inspect retained output before rerunning the full suite.',
        );
      const reservation = { family, attempt: attempts + 1, limit, selection };
      this.store.appendExecution(execution.id, 'implementation.diagnostic_requested', {
        ...reservation,
        implementationId: run.id,
      });
      return reservation;
    });
  }

  /** Links the actual result to its reservation; neither provisional findings nor budget counts are evidence. */
  settled(
    reservation: { family: string; attempt: number; limit: number; selection: DiagnosticSelection },
    check: RepositoryCheck,
  ): void {
    this.store.appendExecution(check.executionId, 'implementation.diagnostic_finished', {
      ...reservation,
      implementationId: this.implementationId,
      checkId: check.id,
    });
  }
}

/** A repeated whole-file selection is not focused when the approved runner can select individual cases. */
function focusedSelection(
  grammar: DiagnosticGrammar,
  selection: DiagnosticSelection,
  previous: DiagnosticSelection,
): boolean {
  if (Object.keys(selection.parameters ?? {}).length) return true;
  const files = selection.files ?? [],
    before = previous.files ?? [];
  if (grammar.parameters.length)
    return files.length > 0 && before.length > files.length && files.every(file => before.includes(file));
  return !grammar.fileSuffixes.length || files.length > 0;
}
