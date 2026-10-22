// A comparison runs one request under several recipes from the same base commit, as one task per recipe
// (an entry), so each recipe's pipeline is measured on equal terms. This module owns the comparison's own
// append-only log (`<data>/comparisons/<id>/events.jsonl`), its command queue and the fold. Entries are
// ordinary tasks: the comparison driver creates them and queues commands for them, like any client.
//
// Modes: `shared` writes and approves one spec in the first entry and gives it to the others, isolating
// the build stages; `full` runs every recipe end to end, so spec quality counts too, and then runs every
// entry's checks against every entry's result, so a lax spec cannot make its own recipe look good.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { inputLimits } from '../config/limits.js';
import type { CheckResult } from '../domain/events.js';
import type { Recipe } from '../domain/recipe.js';
import { appendRecord, readRecords } from '../store/task-store.js';

/** The comparison log schema. Logs written with another schema are refused; there are no migrations. */
export const comparisonSchemaVersion = 1;

export type ComparisonMode = 'shared' | 'full';

/** One cell of the cross-check: one entry's spec checks run against another entry's result. */
export interface CrossCheckCell {
  /** The entry whose spec (and acceptance tests) supplied the checks. */
  specOf: string;
  /** The entry whose commit was checked. */
  candidate: string;
  sha: string | null;
  results: CheckResult[] | null;
  /** Why the cell could not be measured. */
  error: string | null;
  /**
   * Failed checks whose log shows the copied tests did not compile or load against the candidate: the
   * two entries disagree on an API, which says nothing about the candidate's behaviour. Still not a pass.
   * Absent in cells recorded before Grampus told them apart.
   */
  incompatible?: string[];
}

export type ComparisonEvent =
  | { type: 'log.header'; schema: number }
  | {
      type: 'comparison.created';
      comparisonId: string;
      title: string;
      request: string;
      repoPath: string;
      mode: ComparisonMode;
      recipes: Recipe[];
      concurrency: number;
    }
  | { type: 'comparison.terminal'; terminal: string }
  | { type: 'driver.started'; pid: number }
  | { type: 'driver.stopped'; reason: string }
  /** The commit every entry starts from: the first entry's base. */
  | { type: 'base.fixed'; sha: string }
  | { type: 'entry.created'; taskId: string; recipe: string }
  /** Shared mode: the first entry's approved spec, handed to the others. */
  | { type: 'spec.shared'; fromTask: string; version: number }
  /** The cross-check began; it runs one cell per driver pass, so commands still apply between cells. */
  | { type: 'cross_check.started'; total: number }
  | { type: 'cross_check.cell'; cell: CrossCheckCell }
  /** Every cell is in. */
  | { type: 'cross_check.recorded'; cells: CrossCheckCell[] }
  | { type: 'attention.needed'; reason: string; detail: string }
  | { type: 'command.applied'; command: ComparisonCommand }
  | { type: 'command.refused'; command: ComparisonCommand; reason: string }
  | { type: 'comparison.finished'; outcome: 'picked' | 'abandoned'; winner: string | null };

export type StoredComparisonEvent = ComparisonEvent & { at: string };

export const comparisonCommandSchema = z.intersection(
  z.object({ id: z.uuid(), at: z.string(), source: z.enum(['cli', 'chat', 'dashboard']) }),
  z.discriminatedUnion('kind', [
    /** Accept this entry as the result; every other entry ends as not selected. */
    z.object({ kind: z.literal('pick'), taskId: z.string().min(1).max(inputLimits.titleLength) }),
    z.object({ kind: z.literal('abandon'), reason: z.string().max(inputLimits.feedbackLength).optional() }),
  ]),
);
export type ComparisonCommand = z.infer<typeof comparisonCommandSchema>;

/** File access for one comparison. */
export class ComparisonStore {
  readonly eventsPath: string;
  readonly commandsPath: string;

  /** Checked before every append; the comparison driver uses it to stop writing once it lost its lock. */
  private fence: (() => void) | null = null;

  private constructor(readonly dir: string) {
    this.eventsPath = join(dir, 'events.jsonl');
    this.commandsPath = join(dir, 'commands.jsonl');
  }

  /** Run `check` before every later append. It throws to refuse the write. */
  fenceWith(check: () => void): void {
    this.fence = check;
  }

  static create(dataDir: string, comparisonId: string): ComparisonStore {
    const store = new ComparisonStore(comparisonDirectory(dataDir, comparisonId));
    if (existsSync(store.eventsPath)) throw new Error(`Comparison ${comparisonId} already exists.`);
    mkdirSync(store.dir, { recursive: true });
    store.append({ type: 'log.header', schema: comparisonSchemaVersion });
    return store;
  }

  static open(dataDir: string, comparisonId: string): ComparisonStore {
    const store = new ComparisonStore(comparisonDirectory(dataDir, comparisonId));
    if (!existsSync(store.eventsPath)) throw new Error(`Comparison ${comparisonId} was not found in ${dataDir}.`);
    const [header] = store.events();
    if (header?.type !== 'log.header' || header.schema !== comparisonSchemaVersion)
      throw new Error(`Comparison ${comparisonId} was written by another Grampus version; its log is not readable.`);
    return store;
  }

  append(event: ComparisonEvent): StoredComparisonEvent {
    this.fence?.();
    const stored: StoredComparisonEvent = { ...event, at: new Date().toISOString() };
    appendRecord(this.eventsPath, stored);
    return stored;
  }

  events(): StoredComparisonEvent[] {
    return readRecords(this.eventsPath) as StoredComparisonEvent[];
  }

  addCommand(command: ComparisonCommand): void {
    appendRecord(this.commandsPath, comparisonCommandSchema.parse(command));
  }

  commands(): ComparisonCommand[] {
    if (!existsSync(this.commandsPath)) return [];
    return readRecords(this.commandsPath).map(record => comparisonCommandSchema.parse(record));
  }

  /** Folder for one cross-check cell's logs. */
  crossCheckDir(specOf: string, candidate: string): string {
    const dir = join(this.dir, 'cross-check', `${specOf}--${candidate}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** Comparison ids in the data directory, oldest first by id. */
export function listComparisonIds(dataDir: string): string[] {
  const root = join(dataDir, 'comparisons');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'events.jsonl')))
    .map(entry => entry.name)
    .sort();
}

function comparisonDirectory(dataDir: string, comparisonId: string): string {
  if (!/^[a-z0-9-]+$/.test(comparisonId)) throw new Error(`Invalid comparison id: ${comparisonId}`);
  return join(dataDir, 'comparisons', comparisonId);
}

export interface ComparisonState {
  comparisonId: string;
  title: string;
  request: string;
  repoPath: string;
  mode: ComparisonMode;
  recipes: Recipe[];
  concurrency: number;
  createdAt: string;
  terminal: string | null;
  baseSha: string | null;
  /** Entries in creation order, one per recipe. */
  entries: { taskId: string; recipe: string; createdAt: string }[];
  sharedSpec: { fromTask: string; version: number } | null;
  crossCheck: CrossCheckCell[] | null;
  /** Cells measured so far, and how many there will be once the cross-check has started. */
  crossCheckCells: CrossCheckCell[];
  crossCheckTotal: number | null;
  attention: { reason: string; detail: string; since: string } | null;
  /** The latest refused command, until a command is applied. */
  refused: { kind: ComparisonCommand['kind']; reason: string; at: string } | null;
  applied: Set<string>;
  /** The deciding command, once applied. */
  decision: ComparisonCommand | null;
  finished: { outcome: 'picked' | 'abandoned'; winner: string | null; at: string } | null;
  lastStop: { reason: string; at: string } | null;
}

/** Fold a comparison's events into its state. */
export function foldComparison(events: readonly StoredComparisonEvent[]): ComparisonState {
  const created = events.find(event => event.type === 'comparison.created');
  if (created?.type !== 'comparison.created') throw new Error('The comparison log has no comparison.created event.');
  const state: ComparisonState = {
    comparisonId: created.comparisonId,
    title: created.title,
    request: created.request,
    repoPath: created.repoPath,
    mode: created.mode,
    recipes: created.recipes,
    concurrency: created.concurrency,
    createdAt: created.at,
    terminal: null,
    baseSha: null,
    entries: [],
    sharedSpec: null,
    crossCheck: null,
    crossCheckCells: [],
    crossCheckTotal: null,
    attention: null,
    refused: null,
    applied: new Set(),
    decision: null,
    finished: null,
    lastStop: null,
  };
  for (const event of events) applyComparisonEvent(state, event);
  return state;
}

export function applyComparisonEvent(state: ComparisonState, event: StoredComparisonEvent): void {
  switch (event.type) {
    case 'log.header':
    case 'comparison.created':
      return;
    case 'comparison.terminal':
      state.terminal = event.terminal;
      return;
    case 'driver.started':
      state.lastStop = null;
      return;
    case 'driver.stopped':
      state.lastStop = { reason: event.reason, at: event.at };
      return;
    case 'base.fixed':
      state.baseSha = event.sha;
      return;
    case 'entry.created':
      state.entries.push({ taskId: event.taskId, recipe: event.recipe, createdAt: event.at });
      return;
    case 'spec.shared':
      state.sharedSpec = { fromTask: event.fromTask, version: event.version };
      return;
    case 'cross_check.started':
      state.crossCheckTotal = event.total;
      return;
    case 'cross_check.cell':
      state.crossCheckCells.push(event.cell);
      return;
    case 'cross_check.recorded':
      state.crossCheck = event.cells;
      return;
    case 'attention.needed':
      state.attention = { reason: event.reason, detail: event.detail, since: event.at };
      return;
    case 'command.applied':
      state.applied.add(event.command.id);
      state.decision = event.command;
      state.attention = null;
      state.refused = null;
      return;
    case 'command.refused':
      state.applied.add(event.command.id);
      state.refused = { kind: event.command.kind, reason: event.reason, at: event.at };
      return;
    case 'comparison.finished':
      state.finished = { outcome: event.outcome, winner: event.winner, at: event.at };
      state.attention = null;
      return;
  }
}
