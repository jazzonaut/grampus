// Owns the implementation's command capabilities: exact approved diagnostics and a scoped formatter.
// Commands run serially under the parent lease; agent arguments can select a capability, never alter it.
import type { Store } from '../persistence/store.js';
import type { GuidedCommand } from '../domain/guided-plan.js';
import { Checks } from '../verification/checks.js';
import { Workspaces } from '../repository/workspaces.js';
import { captureRepository } from '../repository/repository-evidence.js';
import { verifyEditingScope } from './edit-policy.js';
import { checkFeedback } from '../verification/check-output.js';
import { runCheckProcess, type CheckProcessOptions, type CheckProcessResult } from '../process/check-process.js';
import { deepEqual } from '../domain/deep-equal.js';
import { providerLimits } from '../config/limits.js';
import { diagnosticArguments, type DiagnosticGrammar, type DiagnosticSelection } from '../domain/diagnostics.js';

/** One implementation's controller-owned command interface, also used for final automatic formatting. */
export class ImplementationCommands {
  private busy = false;
  private used = 0;
  private readonly commands = new Map<string, GuidedCommand>();
  private readonly grammars = new Map<string, DiagnosticGrammar>();

  /** Native edit authorisation is suspended while the command's snapshots are being observed. */
  get running(): boolean {
    return this.busy;
  }

  /** Low-level implementations without an approved guided command set receive no command tool. */
  get available(): boolean {
    return this.commands.size > 0;
  }

  constructor(
    private readonly store: Store,
    private readonly implementationId: string,
    private readonly runner: (options: CheckProcessOptions) => Promise<CheckProcessResult> = runCheckProcess,
  ) {
    const run = store.implementation(implementationId),
      execution = store.execution(run.executionId);
    const task = store.get(execution.taskId),
      guided = task.guided;
    if (!guided || guided.approvedDigest !== guided.digest || task.version !== execution.version) return;
    const slice = guided.plan.slices[execution.sliceIndex];
    if (!slice || !deepEqual(run.policy, guided.policy)) return;
    if (slice.formatting) this.commands.set('format', slice.formatting);
    for (const { selection, ...command } of slice.diagnostics) {
      const name = `diagnostic:${command.name}`;
      this.commands.set(name, command);
      this.grammars.set(name, selection);
    }
    for (const { kind, ...command } of slice.readiness) this.commands.set(`readiness:${kind}`, command);
    this.commands.set('validation', slice.validation);
  }

  /** The exact capabilities shown to the implementer; acceptance remains independent. */
  instructions(): string {
    return `Use grampus_run_check(name, parameters?, files?) to format or check your current edits and repair failures before finishing. Approved command identifiers and diagnostic selection grammars: ${JSON.stringify([...this.commands].map(([id, command]) => ({ id, name: command.name, selection: this.grammars.get(id) })))}. Only diagnostic families accept parameters and files. Commands and outputs are controller-recorded diagnostics; final readiness, validation and acceptance still apply after your last edit. Commands run serially; wait for the result before editing again. No shell is available.`;
  }

  /** Executes one exact capability, snapshots its actual input and returns retained diagnostics. */
  async run(name: string, selection: DiagnosticSelection = {}): Promise<unknown> {
    return this.execute(name, false, selection);
  }

  /** Final formatting has its own single invocation and cannot be starved by diagnostic requests. */
  private async execute(name: string, final: boolean, selection: DiagnosticSelection = {}): Promise<unknown> {
    const command = this.commands.get(name);
    if (!command) throw new Error('Unknown approved implementation command');
    if (this.busy) throw new Error('Wait for the active implementation command before requesting another');
    if (!final && this.used >= providerLimits.implementationCommands)
      throw new Error('Implementation command allowance exhausted');
    this.busy = true;
    if (!final) this.used++;
    try {
      const run = this.store.implementation(this.implementationId),
        execution = this.store.execution(run.executionId);
      const workspaces = new Workspaces(this.store);
      const snapshot = await captureRepository(workspaces, execution);
      const grammar = this.grammars.get(name);
      if (!grammar && Object.keys(selection).length)
        throw new Error('This command has no approved diagnostic parameters');
      const args = grammar
        ? [
            ...command.args,
            ...diagnosticArguments(
              grammar,
              selection,
              new Set(snapshot.files.filter(file => file.sha256 !== null).map(file => file.path)),
            ),
          ]
        : command.args;
      if (!run.before) throw new Error('Implementation has no bound input snapshot');
      verifyEditingScope(
        { cwd: workspaces.path(execution.workspaceId), policy: run.policy, snapshot: run.before },
        snapshot,
      );
      const check = await new Checks(this.store, workspaces).duringImplementation(
        run.id,
        {
          ...command,
          args,
          artifact: snapshot.artifact,
          instructionsDigest: snapshot.instructionsDigest,
          ...(name === 'format'
            ? {
                preparation: {
                  scope: {
                    files: [...run.policy.files, ...(run.policy.create ?? [])].filter(path =>
                      snapshot.files.some(file => file.path === path && file.sha256 !== null),
                    ),
                  },
                },
              }
            : {}),
        },
        this.runner,
      );
      if (check.phase === 'recovery_required' || check.error)
        throw new Error(check.error ?? 'Implementation command needs recovery');
      return checkFeedback(check);
    } finally {
      this.busy = false;
    }
  }

  /** Formats after the final edit without spending a provider turn or a repair round. */
  async finish(): Promise<void> {
    if (!this.commands.has('format')) return;
    const result = await this.execute('format', true);
    // The authoritative record decides the outcome, never a provider's summary of the command.
    const run = this.store.implementation(this.implementationId);
    const check = this.store.checks(run.executionId).findLast(check => check.implementationId === run.id);
    if (check?.phase !== 'passed') throw new Error(`Automatic formatting failed: ${JSON.stringify(result)}`);
  }
}
