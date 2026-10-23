// The comparison driver: one process per comparison, in an Orca terminal in the repository's main checkout.
// It is the only writer to the comparison's log. It creates one entry task per recipe (no more running at
// once than the comparison's concurrency), hands the shared spec on in shared mode, runs the cross-check
// in full mode, asks the user to pick, and applies the pick by queueing commands for the entries, exactly
// as the CLI would. Every step reads the logs first, so a restarted driver continues where it stopped.
import { setTimeout as sleep } from 'node:timers/promises';
import { currentSettings } from '../config/settings.js';
import { queueCommand } from '../control.js';
import type { OrcaWorkspaces } from '../orca/client.js';
import { installedBuild } from '../install/installation.js';
import { createTask, type InheritedSpec } from '../pipeline/create-task.js';
import { closeOwnTab } from '../pipeline/driver.js';
import { acquireDriverLock, LockLost } from '../store/driver-lock.js';
import { foldEvents, type TaskState } from '../pipeline/state.js';
import { listTaskIds, TaskStore } from '../store/task-store.js';
import {
  applyComparisonEvent,
  ComparisonStore,
  foldComparison,
  type ComparisonCommand,
  type ComparisonEvent,
  type ComparisonState,
} from './comparison.js';
import { crossCheckCell, crossCheckPairs } from './cross-check.js';

export interface ComparisonDriverOptions {
  dataDir: string;
  comparisonId: string;
  orca: OrcaWorkspaces;
  /** The command line that runs this CLI, for the entries' driver terminals. */
  selfCommand: string;
  log: (line: string) => void;
}

/** Whether an entry has gone as far as it can without the user: finished, or waiting to be accepted. */
export function entryDone(state: TaskState): boolean {
  return state.finished !== null || /^(ready|escalate):/.test(state.attention?.reason ?? '');
}

/** Whether an entry can be picked now: it waits for acceptance. */
export function entryPickable(state: TaskState): boolean {
  return state.finished === null && (state.attention?.options.includes('accept') ?? false);
}

class ComparisonDriver {
  readonly store: ComparisonStore;
  readonly state: ComparisonState;

  constructor(readonly options: ComparisonDriverOptions) {
    this.store = ComparisonStore.open(options.dataDir, options.comparisonId);
    this.state = foldComparison(this.store.events());
  }

  record(event: ComparisonEvent): void {
    applyComparisonEvent(this.state, this.store.append(event));
  }

  entry(taskId: string): TaskState {
    return foldEvents(TaskStore.open(this.options.dataDir, taskId).events());
  }

  entries(): TaskState[] {
    return this.state.entries.map(entry => this.entry(entry.taskId));
  }

  /** One pass: commands, new entries, the cross-check and the pick. Returns true when the comparison is over. */
  async step(): Promise<boolean> {
    this.applyCommands();
    if (this.state.decision) return this.finishWhenEntriesEnd();
    await this.createEntries();
    await this.askForPick();
    return this.state.finished !== null;
  }

  private applyCommands(): void {
    for (const command of this.store.commands()) {
      if (this.state.applied.has(command.id)) continue;
      const refusal = this.refusal(command);
      if (refusal) {
        this.record({ type: 'command.refused', command, reason: refusal });
        this.options.log(`Refused ${command.kind}: ${refusal}`);
        continue;
      }
      for (const entry of this.entries()) {
        if (entry.finished) continue;
        const body =
          command.kind === 'abandon'
            ? { kind: 'abandon' as const, reason: command.reason ?? 'the comparison was abandoned' }
            : { kind: entry.taskId === command.taskId ? ('accept' as const) : ('decline' as const) };
        queueCommand(this.options.dataDir, entry.taskId, command.source, body);
      }
      this.record({ type: 'command.applied', command });
      this.options.log(command.kind === 'pick' ? `Picked ${command.taskId}.` : 'Comparison abandoned.');
    }
  }

  private refusal(command: ComparisonCommand): string | null {
    if (this.state.decision || this.state.finished) return 'the comparison is already decided';
    if (command.kind === 'abandon') return null;
    if (!this.state.entries.some(entry => entry.taskId === command.taskId))
      return `${command.taskId} is not an entry of this comparison`;
    // A pick sent before the comparison asked was made without the finished entries and cross-check in
    // view; one once waited two hours behind the cross-check and was then applied unseen.
    const asked = this.state.attention?.reason === 'pick' ? Date.parse(this.state.attention.since) : null;
    if (asked === null || Date.parse(command.at) < asked)
      return 'the comparison has not asked for a pick yet; pick once every entry has finished and the cross-check is in';
    return entryPickable(this.entry(command.taskId)) ? null : `${command.taskId} is not waiting for acceptance`;
  }

  private finishWhenEntriesEnd(): boolean {
    if (this.state.finished) return true;
    if (!this.entries().every(entry => entry.finished)) return false;
    const decision = this.state.decision;
    this.record({
      type: 'comparison.finished',
      outcome: decision?.kind === 'pick' ? 'picked' : 'abandoned',
      winner: decision?.kind === 'pick' ? decision.taskId : null,
    });
    this.options.log('Comparison finished.');
    return true;
  }

  private async createEntries(): Promise<void> {
    this.adoptOrphans();
    const { recipes, mode, concurrency } = this.state;
    if (mode === 'shared' && this.state.entries.length && !this.state.sharedSpec) {
      if (!this.shareSpec()) return;
    }
    const entries = this.entries();
    let active = entries.filter(entry => !entryDone(entry)).length;
    while (active < concurrency && this.state.entries.length < recipes.length) {
      // In shared mode the other entries wait for the first entry's approved spec.
      if (mode === 'shared' && this.state.entries.length && !this.state.sharedSpec) return;
      await this.createEntry(this.state.entries.length);
      active++;
    }
  }

  /** An entry created just before a crash, before its `entry.created` was recorded, joins the comparison. */
  private adoptOrphans(): void {
    const known = new Set(this.state.entries.map(entry => entry.taskId));
    for (const taskId of listTaskIds(this.options.dataDir)) {
      if (known.has(taskId)) continue;
      let state: TaskState;
      try {
        state = this.entry(taskId);
      } catch {
        continue;
      }
      if (state.comparisonId !== this.state.comparisonId || !state.workspace) continue;
      this.record({ type: 'entry.created', taskId, recipe: state.recipe.name });
      if (!this.state.baseSha) this.record({ type: 'base.fixed', sha: state.workspace.baseSha });
    }
  }

  /** Record the first entry's approved spec for the others. False while it is not approved yet. */
  private shareSpec(): boolean {
    const first = this.state.entries[0];
    if (!first) return false;
    const lead = this.entry(first.taskId);
    const approval = lead.commands.findLast(command => command.kind === 'approve');
    // A shared comparison uses one acceptance-test commit, not independently authored suites.
    if (lead.recipe.testsFirst && !lead.testBaseline && !lead.finished) return false;
    if (approval?.kind !== 'approve') {
      if (lead.finished) {
        this.record({ type: 'comparison.finished', outcome: 'abandoned', winner: null });
        this.options.log(`${lead.taskId} ended without an approved spec, so the comparison ends.`);
      }
      return false;
    }
    this.record({ type: 'spec.shared', fromTask: lead.taskId, version: approval.specVersion });
    this.options.log(`Spec v${approval.specVersion} of ${lead.taskId} is shared with the other entries.`);
    return true;
  }

  private inheritedSpec(): InheritedSpec | null {
    const shared = this.state.sharedSpec;
    if (!shared) return null;
    const spec = this.entry(shared.fromTask).specs.find(item => item.version === shared.version);
    if (!spec) throw new Error(`Spec v${shared.version} of ${shared.fromTask} is missing.`);
    return {
      fromTask: shared.fromTask,
      fromVersion: shared.version,
      path: spec.path,
      hash: spec.hash,
      checks: spec.checks,
      acceptance: spec.acceptance,
      protected: spec.protected,
      tests: this.entry(shared.fromTask).testsFirst ?? { sha: this.state.baseSha ?? '', files: [] },
    };
  }

  private async createEntry(index: number): Promise<void> {
    const recipe = this.state.recipes[index];
    if (!recipe) return;
    const created = await createTask(
      {
        dataDir: this.options.dataDir,
        repoPath: this.state.repoPath,
        request: this.state.request,
        title: `${this.state.title} [${recipe.name}]`,
        recipeName: recipe.name,
        recipe,
        driveCommand: taskId => `${this.options.selfCommand} drive ${taskId}`,
        comparison: { comparisonId: this.state.comparisonId, baseSha: this.state.baseSha, spec: this.inheritedSpec() },
      },
      this.options.orca,
    );
    this.record({ type: 'entry.created', taskId: created.taskId, recipe: recipe.name });
    this.options.log(`Entry ${created.taskId} started with recipe ${recipe.name}.`);
    if (!this.state.baseSha) {
      const workspace = this.entry(created.taskId).workspace;
      if (workspace) this.record({ type: 'base.fixed', sha: workspace.baseSha });
    }
  }

  private async askForPick(): Promise<void> {
    if (this.state.attention || this.state.entries.length < this.state.recipes.length) return;
    const entries = this.entries();
    if (!entries.every(entryDone)) return;
    if (entries.every(entry => entry.finished)) {
      // Every entry ended without being picked, such as all abandoned one by one: nothing is left to pick.
      this.record({ type: 'comparison.finished', outcome: 'abandoned', winner: null });
      return;
    }
    if (this.state.mode === 'full' && !this.state.crossCheck && this.state.baseSha) {
      if (!(await this.crossCheckOneCell(entries, this.state.baseSha))) return;
    }
    const ready = entries.filter(entry => entry.attention?.reason.startsWith('ready:')).length;
    this.record({
      type: 'attention.needed',
      reason: 'pick',
      detail: `Every entry has finished its rounds (${ready} of ${entries.length} passed everything). Pick the one to keep; the others end as not selected.`,
    });
    this.options.log('Needs you: pick an entry.');
  }

  /**
   * Measure the next cross-check cell, or record the whole cross-check once every cell is in. One cell per
   * pass keeps commands applying and progress visible, and a restarted driver skips the cells it has.
   * Returns true when the cross-check is complete.
   */
  private async crossCheckOneCell(entries: readonly TaskState[], baseSha: string): Promise<boolean> {
    const pairs = crossCheckPairs(entries);
    if (this.state.crossCheckTotal === null) this.record({ type: 'cross_check.started', total: pairs.length });
    const cellOf = (owner: string, candidate: string) =>
      this.state.crossCheckCells.find(cell => cell.specOf === owner && cell.candidate === candidate);
    const next = pairs.find(pair => !cellOf(pair.owner.taskId, pair.candidate.taskId));
    if (next) {
      const cell = await crossCheckCell(this.store, next.owner, next.candidate, baseSha, this.options.log);
      this.record({ type: 'cross_check.cell', cell });
      return false;
    }
    const cells = pairs.flatMap(pair => cellOf(pair.owner.taskId, pair.candidate.taskId) ?? []);
    this.record({ type: 'cross_check.recorded', cells });
    return true;
  }
}

/** Run a comparison's driver until the comparison is over or the driver must stop. Returns the exit code. */
export async function driveComparison(options: ComparisonDriverOptions & { orca: OrcaWorkspaces }): Promise<number> {
  const lock = acquireDriverLock(ComparisonStore.open(options.dataDir, options.comparisonId).dir);
  let finished = false;
  try {
    const driver = new ComparisonDriver(options);
    driver.store.fenceWith(() => lock.assertHeld());
    if (driver.state.finished) return 0;
    const build = installedBuild()?.build;
    driver.record({
      type: 'driver.started',
      pid: process.pid,
      terminal: process.env.ORCA_TERMINAL_HANDLE ?? null,
      ...(build ? { build } : {}),
    });
    options.log(`Driving comparison ${driver.state.comparisonId}: ${driver.state.title}`);
    try {
      while (!(await driver.step())) await sleep(currentSettings().waitPollMs);
    } catch (error) {
      // The log belongs to the driver that took over; even the reason for stopping is not ours to record.
      const reason = error instanceof LockLost ? null : ((error as Error).stack ?? String(error));
      if (reason) driver.record({ type: 'driver.stopped', reason });
      options.log(`Stopped: ${reason ?? (error as Error).message}`);
      return 1;
    }
    finished = true;
    return 0;
  } finally {
    lock.release();
    if (finished) await closeOwnTab(options.orca, options.log);
  }
}
