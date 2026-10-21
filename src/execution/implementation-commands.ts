// Owns the approved format/check/repair cycle. All children retain the parent implementation lease.
import type { Store } from '../persistence/store.js';
import type { GuidedCommand } from '../domain/guided-plan.js';
import type { CheckSpec, RepositoryCheck } from '../persistence/records.js';
import { Checks } from '../verification/checks.js';
import { Workspaces } from '../repository/workspaces.js';
import { captureRepository } from '../repository/repository-evidence.js';
import { verifyEditingScope } from './edit-policy.js';
import { checkFeedback, conciseCheckFeedback } from '../verification/check-output.js';
import { runCheckProcess, type CheckProcessOptions, type CheckProcessResult } from '../process/check-process.js';
import { deepEqual } from '../domain/deep-equal.js';
import { providerLimits } from '../config/limits.js';
import { diagnosticArguments, type DiagnosticGrammar, type DiagnosticSelection } from '../domain/diagnostics.js';
import { directoryAllows } from './directory-scope.js';
import { checkInputFingerprint } from '../verification/check-inputs.js';
import { measurePhase, measureSyncPhase } from './phase-timing.js';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import type { EditPolicy } from './edit-policy.js';
import { successfulCheck } from '../verification/check-reuse.js';
import { nativeCreationPaths } from './native-creations.js';
import { DiagnosticBudget } from './diagnostic-budget.js';
import { reusableImplementationDiagnostic } from '../verification/check-reuse.js';

/** Controller-owned diagnostics; final formatting cannot be starved by agent requests. */
export class ImplementationCommands {
  private busy = false;
  private uncertain = false;
  private used = 0;
  private readonly commands = new Map<string, GuidedCommand>();
  private readonly grammars = new Map<string, DiagnosticGrammar>();
  private readonly diagnosticLimits = new Map<string, number>();
  private readonly reusedChecks = new Set<string>();
  private readonly readiness: string[] = [];
  private concurrency = 1;
  private prepared: RepositorySnapshot | undefined;
  private pending: Promise<unknown> | null = null;

  /** Native editing is suspended throughout command groups, including their snapshots. */
  get running(): boolean {
    return this.busy || this.uncertain;
  }
  /** Low-level implementations without approved commands receive no command tool. */
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
    this.concurrency = slice.readinessConcurrency;
    if (slice.formatting) this.commands.set('format', slice.formatting);
    for (const { selection, maxRuns, ...command } of slice.diagnostics) {
      const name = `diagnostic:${command.name}`;
      this.commands.set(name, command);
      this.grammars.set(name, selection);
      this.diagnosticLimits.set(name, maxRuns);
    }
    for (const { kind, ...command } of slice.readiness) {
      const name = `readiness:${kind}`;
      this.commands.set(name, command);
      this.readiness.push(name);
    }
    this.commands.set('validation', slice.validation);
  }

  /** Capabilities are turn-specific data; the shared tool definition stays stable for prefix caching. */
  instructions(): string {
    return `Use grampus_run_check(name, parameters?, files?) for approved diagnostics. Before finishing use name="finish": format first, run approved independent readiness checks together, then validation. Repair returned failures and repeat within this turn. Approved identifiers and diagnostic grammars: ${JSON.stringify([...this.commands].map(([id, command]) => ({ id, name: command.name, selection: this.grammars.get(id), maxRuns: this.diagnosticLimits.get(id) })))}. Diagnostic family budgets cover all selections and repair attempts in this slice. After a failure inspect the assertion, logs and relevant source, then select only the failing case/file. Do not repeatedly run full browser or unit suites while debugging or change assertions merely to obtain a pass. Final approved checks retain complete coverage. Only diagnostic families accept parameters and files. Wait for the entire operation before editing. Final gates adopt only eligible exact-input results; acceptance remains separate. No shell is available.`;
  }

  /** Runs one approved diagnostic or a complete finishing cycle while the provider remains active. */
  async run(name: string, selection: DiagnosticSelection = {}): Promise<unknown> {
    return this.exclusive(async () => {
      if (name !== 'finish') {
        const feedback = this.feedbackFor(await this.execute(name, selection));
        const limit = this.diagnosticLimits.get(name);
        return limit === undefined
          ? feedback
          : {
              ...feedback,
              diagnosticBudget: new DiagnosticBudget(this.store, this.implementationId).usage(name, limit),
            };
      }
      if (Object.keys(selection).length) throw new Error('Finishing has no diagnostic parameters');
      return this.completeCycle();
    });
  }

  private async completeCycle(): Promise<unknown> {
    const results: RepositoryCheck[] = [];
    if (this.commands.has('format')) {
      const format = await this.execute('format');
      results.push(format);
      if (format.phase !== 'passed') return this.feedback(results);
    }
    if (this.readiness.length) {
      const specs = await this.readinessSpecs();
      const reused = specs.map(spec => this.reusable(spec));
      const pending = specs.filter((_, index) => !reused[index]);
      this.spend(pending.length);
      const checks = new Checks(this.store, new Workspaces(this.store));
      const fresh = pending.length
        ? await checks.duringImplementationGroup(
            this.implementationId,
            pending,
            this.concurrency,
            this.runner,
            this.prepared,
          )
        : [];
      results.push(
        ...reused.map(check => {
          const result = check ?? fresh.shift();
          if (!result) throw new Error('Finishing diagnostic result is missing');
          return result;
        }),
      );
      this.requireSettled(results);
      if (results.some(check => check.phase !== 'passed')) return this.feedback(results);
    }
    results.push(await this.execute('validation'));
    return this.feedback(results);
  }

  private async readinessSpecs(): Promise<CheckSpec[]> {
    const first = this.readiness[0];
    if (!first) return [];
    const bound = await this.spec(first);
    return this.readiness.map(name => {
      const command = this.commands.get(name);
      if (!command) throw new Error('Approved readiness command is missing');
      return { ...command, artifact: bound.artifact, instructionsDigest: bound.instructionsDigest };
    });
  }

  private feedback(checks: RepositoryCheck[]) {
    return {
      phase: checks.every(check => check.phase === 'passed') ? 'passed' : 'failed',
      checks: checks.map(check => this.feedbackFor(check)),
    };
  }

  private feedbackFor(check: RepositoryCheck) {
    return { ...conciseCheckFeedback(check), ...(this.reusedChecks.has(check.id) ? { reused: true } : {}) };
  }

  private requireSettled(checks: RepositoryCheck[]): void {
    const unsettled = checks.find(check => ['running', 'recovery_required'].includes(check.phase));
    if (unsettled) throw new Error(unsettled.error ?? 'Implementation command needs recovery');
  }

  private spend(count: number): void {
    if (this.used + count > providerLimits.implementationCommands)
      throw new Error('Implementation command allowance exhausted');
    this.used += count;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running)
      return Promise.reject(
        new Error('An implementation command is still unsettled; wait for settlement or recover its uncertain exit'),
      );
    this.busy = true;
    const pending = this.operate(operation);
    this.pending = pending;
    const settled = () => {
      if (this.pending === pending) this.pending = null;
    };
    void pending.then(settled, settled);
    return pending;
  }

  private async operate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const run = this.store.implementation(this.implementationId),
        execution = this.store.execution(run.executionId);
      const session = this.store.session(execution.sessionId);
      if (
        run.phase !== 'running' ||
        session.phase !== 'running' ||
        session.run?.id !== run.id ||
        this.store.lease(execution.workspaceId)?.runId !== run.id
      )
        throw new Error('Implementation command requires its active owned turn');
      return await operation();
    } finally {
      const executionId = this.store.implementation(this.implementationId).executionId;
      this.uncertain = this.store
        .checks(executionId)
        .some(
          check =>
            check.implementationId === this.implementationId && ['running', 'recovery_required'].includes(check.phase),
        );
      this.busy = false;
      this.prepared = undefined;
    }
  }

  /** Joins already-dispatched work before provider shutdown; uncertainty remains fenced for recovery. */
  async settlePending(): Promise<void> {
    if (this.pending) await this.pending;
    if (this.uncertain) throw new Error('Implementation command needs recovery');
  }

  private async spec(name: string, selection: DiagnosticSelection = {}): Promise<CheckSpec> {
    const command = this.commands.get(name);
    if (!command) throw new Error('Unknown approved implementation command');
    const run = this.store.implementation(this.implementationId),
      execution = this.store.execution(run.executionId);
    const workspaces = new Workspaces(this.store),
      snapshot = await measurePhase(this.store, execution.id, 'snapshot', () =>
        captureRepository(workspaces, execution),
      );
    const grammar = this.grammars.get(name);
    if (!grammar && Object.keys(selection).length)
      throw new Error('This command has no approved diagnostic parameters');
    if (!run.before) throw new Error('Implementation has no bound input snapshot');
    verifyEditingScope(
      { cwd: workspaces.path(execution.workspaceId), policy: run.policy, snapshot: run.before },
      snapshot,
      nativeCreationPaths(this.store.sessionEvents(execution.sessionId, ['tool.authorized']), run.id, run.before),
    );
    this.prepared = snapshot;
    return {
      ...command,
      args: grammar
        ? [
            ...command.args,
            ...diagnosticArguments(
              grammar,
              selection,
              new Set(snapshot.files.filter(file => file.sha256 !== null).map(file => file.path)),
            ),
          ]
        : command.args,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
      ...(name === 'format' ? { preparation: this.formattingScope(snapshot, run.policy, run.before) } : {}),
    };
  }

  /** Directory grants can span a large tree; formatting is restricted to its actual task changes. */
  private formattingScope(snapshot: RepositorySnapshot, policy: EditPolicy, before: RepositorySnapshot) {
    const original = new Map(before.files.map(file => [file.path, file.sha256]));
    const files = snapshot.files
      .filter(
        file =>
          file.sha256 !== null &&
          (policy.files.includes(file.path) ||
            policy.create?.includes(file.path) ||
            (file.sha256 !== original.get(file.path) &&
              (directoryAllows(policy.directories, 'edit', file.path) ||
                directoryAllows(policy.directories, 'create', file.path)))),
      )
      .map(file => file.path);
    return files.length ? { scope: { files } } : {};
  }

  private async execute(name: string, selection: DiagnosticSelection = {}, final = false): Promise<RepositoryCheck> {
    const spec = await this.spec(name, selection);
    const reused = this.reusable(spec);
    if (reused) return reused;
    const grammar = this.grammars.get(name),
      limit = this.diagnosticLimits.get(name);
    const budget = new DiagnosticBudget(this.store, this.implementationId);
    const reservation = grammar && limit !== undefined ? budget.reserve(name, limit, grammar, selection) : null;
    if (!final) this.spend(1);
    const check = await new Checks(this.store, new Workspaces(this.store)).duringImplementation(
      this.implementationId,
      spec,
      this.runner,
      this.prepared,
    );
    if (reservation) budget.settled(reservation, check);
    this.requireSettled([check]);
    if (check.error) throw new Error(check.error);
    return check;
  }

  private reusable(spec: CheckSpec): RepositoryCheck | null {
    const reuse = spec.reuse;
    if (!reuse || spec.preparation) return null;
    const run = this.store.implementation(this.implementationId),
      execution = this.store.execution(run.executionId);
    const fingerprint = measureSyncPhase(this.store, execution.id, 'input_fingerprint', () =>
      checkInputFingerprint(new Workspaces(this.store).path(execution.workspaceId), spec.file, reuse.inputs),
    );
    const source = reusableImplementationDiagnostic(this.store.checks(execution.id), run.id, spec, fingerprint);
    if (source) {
      this.reusedChecks.add(source.id);
      this.store.appendExecution(execution.id, 'implementation.diagnostic_reused', {
        implementationId: run.id,
        checkId: source.id,
        artifact: spec.artifact,
      });
    }
    return source;
  }

  /** Formats after editing unless an explicit reusable formatting receipt proves it unnecessary. */
  async finish(): Promise<void> {
    await this.settlePending();
    if (!this.commands.has('format')) return;
    await this.exclusive(async () => {
      if (await this.alreadyFormatted()) return;
      const check = await this.execute('format', {}, true);
      if (check.phase !== 'passed')
        throw new Error(`Automatic formatting failed: ${JSON.stringify(checkFeedback(check))}`);
    });
  }

  private async alreadyFormatted(): Promise<boolean> {
    if (!this.commands.get('format')?.reuse) return false;
    const spec = await this.spec('format');
    if (!spec.reuse) return false;
    const run = this.store.implementation(this.implementationId),
      execution = this.store.execution(run.executionId);
    const { artifact: _artifact, ...expected } = spec;
    const source = this.store.checks(execution.id).findLast(check => {
      const { artifact: _previous, ...previous } = check.spec;
      return check.implementationId === run.id && deepEqual(previous, expected);
    });
    const fingerprint = checkInputFingerprint(
      new Workspaces(this.store).path(execution.workspaceId),
      spec.file,
      spec.reuse.inputs,
    );
    if (
      !fingerprint ||
      !successfulCheck(source) ||
      source.before?.artifact !== spec.artifact ||
      source.after?.artifact !== spec.artifact ||
      source.inputFingerprint?.before !== fingerprint ||
      source.inputFingerprint?.after !== fingerprint
    )
      return false;
    this.store.appendExecution(execution.id, 'implementation.format_reused', {
      implementationId: run.id,
      checkId: source.id,
      artifact: spec.artifact,
    });
    return true;
  }
}
