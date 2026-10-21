// Owns the SQLite journal: the single current schema, transactions and record access. Rows are parsed
// with zod at this boundary; execution-layer records are validated against persistence/records.ts.
// It stores and returns records but never decides workflow: callers own every state transition.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { defaultDataDirectory } from '../config/runtime.js';
import { planLimits, processLimits } from '../config/limits.js';
import { BoundaryError, parseBoundary, parseJson, validateInPlace } from '../process/boundary.js';
import { repositorySnapshotSchema, type RepositorySnapshot } from '../repository/snapshot-schema.js';
import { RecordNotFoundError } from './errors.js';
import {
  checkSummarySchema,
  deliverySchema,
  executionLeaseSchema,
  executionSchema,
  implementationRunSchema,
  repositoryCheckSchema,
  sessionSchema,
  taskSchema,
  workspaceSchema,
  type Delivery,
  type CheckSummary,
  type Execution,
  type ExecutionLease,
  type ImplementationRun,
  type RepositoryCheck,
  type Session,
  type Workspace,
} from './records.js';
import type { Task } from '../domain/workflow.js';
import { comparisonSchema, type Comparison } from '../domain/comparison.js';
import { healthReportSchema, type HealthReport } from '../health/health-record.js';
import {
  readActivity,
  activitySessionIds,
  activityToolSessionIds,
  type ActivityCursor,
  type ActivityRecord,
  type ActivityScope,
} from './activity.js';

/** The default journal for this installed or development copy. */
export function defaultDatabasePath(): string {
  return join(defaultDataDirectory(), 'grampus.sqlite');
}

/** An event of a task's journal, in the order it was appended (`sequence`). */
export interface JournalEvent {
  sequence: number;
  taskId: string;
  version: number;
  at: string;
  type: string;
  /** Event payloads are open-ended; each reader validates the fields it uses. */
  data: unknown;
}

/** An event of a session, workspace or execution journal. */
export interface RecordEvent {
  sequence: number;
  at: string;
  type: string;
  data: unknown;
}

/** The single journal format this build accepts; other versions are never migrated. */
export const journalSchemaVersion = 14;
const schema = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    runner TEXT GENERATED ALWAYS AS (json_extract(state, '$.guided.owner.token')) VIRTUAL
  );
  CREATE INDEX tasks_runner ON tasks(runner) WHERE runner IS NOT NULL;
  CREATE TABLE snapshots (artifact TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    version INTEGER NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_task ON events(task_id, sequence);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE session_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX session_events_session ON session_events(session_id, sequence);
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    path_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL
  );
  CREATE TABLE workspace_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX workspace_events_workspace ON workspace_events(workspace_id, sequence);
  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
    state TEXT NOT NULL
  );
  CREATE TABLE execution_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL REFERENCES executions(id),
    at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX execution_events_execution ON execution_events(execution_id, sequence);
  CREATE TABLE execution_leases (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
    run_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL
  );
  CREATE TABLE checks (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id),
    state TEXT NOT NULL
  );
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id),
    state TEXT NOT NULL
  );
  CREATE TABLE implementations (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id),
    state TEXT NOT NULL
  );
  CREATE TABLE health (id TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE comparisons (id TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE comparison_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, comparison_id TEXT NOT NULL REFERENCES comparisons(id),
    at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX comparison_events_comparison ON comparison_events(comparison_id, sequence);
`;
const expectedTables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].flatMap(match => (match[1] ? [match[1]] : []));

// Row shapes as SQLite returns them. These pin the columns this module selects.
const stateRow = z.object({ state: z.string() });
const eventRow = z.object({ sequence: z.number(), at: z.string(), type: z.string(), data: z.string() });
const taskEventRow = eventRow.extend({ task_id: z.string(), version: z.number() });
const nameRow = z.object({ name: z.string() });
const summaryRow = z.object({ id: z.string(), title: z.unknown(), status: z.unknown(), stage: z.unknown() });
const idRow = z.object({ id: z.string() });
const activeWorkRow = z.object({
  task_id: z.string(),
  id: z.string(),
  label: z.unknown(),
  directory: z.string().nullable(),
  last: z.string().nullable(),
});
/** The single row of the `health` table. */
const latestHealth = 'latest';

/** A running session or check of a running guided task, as stall detection sees it. */
export interface ActiveWork {
  taskId: string;
  kind: 'session' | 'check';
  id: string;
  /** The session's provider or the check's name. */
  label: string;
  /** The latest event in the session's or the check's execution journal; null when there is none. */
  lastEventAt: string | null;
  /** A check's receipt directory, where its output logs grow; null for sessions and undispatched checks. */
  directory: string | null;
}

type SchemaState = 'empty' | 'current' | 'foreign';
/**
 * `empty` only for a fresh file (no tables, `user_version` 0); anything that is not exactly the current
 * version with every expected table is `foreign` and refused, never migrated.
 */
function schemaState(db: DatabaseSync): SchemaState {
  const version = z.object({ user_version: z.number() }).safeParse(db.prepare('PRAGMA user_version').get());
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(row => nameRow.parse(row).name),
  );
  const current = version.success ? version.data.user_version : -1;
  if (current === 0 && tables.size === 0) return 'empty';
  return current === journalSchemaVersion && expectedTables.every(table => tables.has(table)) ? 'current' : 'foreign';
}
function refuse(path: string): Error {
  return new Error(
    `This journal was created by an older Grampus version and cannot be opened. Start with a fresh journal (the old file is left untouched): ${path}`,
  );
}

const journal = (table: string) => ({ kind: 'journal-record', source: table }) as const;

/** Parse one stored JSON document. */
function document(table: string, row: unknown): unknown {
  return parseJson(parseBoundary(stateRow, row, journal(table)).state, journal(table));
}

/** Validate a stored record in place against its schema; `table` names the source in errors. */
function record<T>(recordSchema: z.ZodType<T, T>, table: string, row: unknown): T {
  return validateInPlace(recordSchema, document(table, row), journal(table));
}

function recordEvent(table: string, row: unknown): RecordEvent {
  const event = parseBoundary(eventRow, row, journal(table));
  return { sequence: event.sequence, at: event.at, type: event.type, data: parseJson(event.data, journal(table)) };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : String(value));

/**
 * All state changes and their evidence are committed in the same transaction.
 *
 * There is one schema version and no migration. A journal from any other version is
 * refused before this connection writes anything to it, so its bytes stay unchanged.
 *
 * Every record (tasks with their guided state, sessions, executions, leases, workspaces, checks,
 * implementations, deliveries, snapshots and health) is validated on every read against its schema in
 * persistence/records.ts or the owning module, and returned with that schema's type. Event payloads
 * stay `unknown`: each reader validates the fields it uses.
 */
export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;
  private transactionDepth = 0;

  /**
   * Opens (or creates) the journal at `path`, or an in-memory journal for `':memory:'`. Throws when the
   * file holds any other schema version, without writing to it.
   */
  constructor(path: string) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:' && existsSync(path) && statSync(path).size > 0) {
      // Inspect read-only first: setting WAL mode or creating tables would rewrite an older journal.
      const existing = new DatabaseSync(path, { readOnly: true });
      try {
        existing.exec(`PRAGMA busy_timeout = ${processLimits.journalBusyMs};`);
        if (schemaState(existing) === 'foreign') throw refuse(this.path);
      } finally {
        existing.close();
      }
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${processLimits.journalBusyMs}; PRAGMA foreign_keys = ON;`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Recheck under the write lock: another process may have created the schema meanwhile.
        const state = schemaState(this.db);
        if (state === 'foreign') throw refuse(this.path);
        if (state === 'empty') this.db.exec(`${schema} PRAGMA user_version = ${journalSchemaVersion};`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Runs `action` in one transaction and returns its result. The outermost call uses `BEGIN IMMEDIATE`,
   * taking the write lock before anything is read, so a check of the current record and the write that
   * depends on it cannot interleave with another controller connection. Nested calls use savepoints:
   * an inner failure rolls back only its own changes and rethrows. Any thrown error rolls back and is
   * rethrown. `action` must be synchronous; work after an `await` would run outside the transaction.
   */
  transaction<T>(action: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = action();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  /**
   * The task record `id`, validated with its guided state. Throws `RecordNotFoundError` when absent
   * and `BoundaryError` when the stored record does not match `taskSchema`.
   *
   * The type parameter has no effect. It remains only because server/ui-server.ts still writes
   * `store.get(id)`; remove it together with those type arguments.
   */
  get<_Unused = Task>(id: string): Task {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Task', id);
    return record(taskSchema, 'tasks', row);
  }

  /** Every task record, validated, in creation order (including deleted tasks, which keep a tombstone). */
  list(): Task[] {
    return this.db
      .prepare('SELECT state FROM tasks ORDER BY rowid')
      .all()
      .map(row => record(taskSchema, 'tasks', row));
  }

  /**
   * A cheap change token for caching reads (the dashboard compares it between polls). Includes commits
   * from other controller connections and writes on this one; it only says whether something may have
   * changed, never what.
   */
  revision(): string {
    const data = z.object({ data_version: z.number() }).parse(this.db.prepare('PRAGMA data_version').get());
    const changes = z.object({ changes: z.number() }).parse(this.db.prepare('SELECT total_changes() AS changes').get());
    return `${data.data_version}:${changes.changes}`;
  }

  /**
   * Title, status and stage of every guided task that is not deleted, in creation order, read with
   * `json_extract` so the sidebar never parses whole task records. Only the selected columns are
   * validated, not the task record; non-string values are stringified.
   */
  guidedSummaries(): { id: string; title: string; status: string; stage: string }[] {
    return this.db
      .prepare(
        `SELECT id, json_extract(state, '$.brief.title') AS title,
      json_extract(state, '$.guided.status') AS status, json_extract(state, '$.guided.stage') AS stage
      FROM tasks WHERE json_type(state, '$.guided') = 'object' AND json_extract(state, '$.deletedAt') IS NULL ORDER BY rowid`,
      )
      .all()
      .map(row => {
        const summary = parseBoundary(summaryRow, row, journal('tasks'));
        return {
          id: summary.id,
          title: text(summary.title),
          status: text(summary.status),
          stage: text(summary.stage),
        };
      });
  }

  /**
   * Tasks whose guided runner is owned, in creation order, including owners kept for recovery.
   * Answered from an indexed column computed when the task is saved, so counting the runner pool never
   * parses task state.
   */
  runnerOwners(): string[] {
    return this.db
      .prepare('SELECT id FROM tasks WHERE runner IS NOT NULL ORDER BY rowid')
      .all()
      .map(row => parseBoundary(idRow, row, journal('tasks')).id);
  }

  /**
   * Stores a repository snapshot once under its artifact digest. The digest covers everything the
   * snapshot records, so an existing row with the same key already holds identical content.
   */
  saveSnapshot(snapshot: RepositorySnapshot): void {
    this.db
      .prepare('INSERT INTO snapshots(artifact, state) VALUES (?, ?) ON CONFLICT(artifact) DO NOTHING')
      .run(snapshot.artifact, JSON.stringify(snapshot));
  }

  /**
   * The stored snapshot of `artifact`, validated, or null when none was stored. Throws `BoundaryError`
   * when the row is malformed or its content names a different artifact digest.
   */
  snapshot(artifact: string): RepositorySnapshot | null {
    const row = this.db.prepare('SELECT state FROM snapshots WHERE artifact = ?').get(artifact);
    if (!row) return null;
    const snapshot = record(repositorySnapshotSchema, 'snapshots', row);
    if (snapshot.artifact !== artifact)
      throw new BoundaryError(journal('snapshots'), ['artifact'], 'Stored snapshot does not match its artifact digest');
    return snapshot;
  }

  /** Inserts or replaces a task record. Call inside `transaction` together with the change's events. */
  save(id: string, state: Task): void {
    this.db
      .prepare('INSERT INTO tasks(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  /** Appends a task journal event; call inside the `transaction` that makes the change it records. */
  append(taskId: string, version: number, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO events(task_id, version, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, version, new Date().toISOString(), type, JSON.stringify(data));
  }

  /**
   * The task's journal events in sequence order, optionally only those of `types` (an empty list
   * returns none). Throws as {@link get} does when the task is missing or malformed.
   */
  events(taskId: string, types?: readonly string[]): JournalEvent[] {
    this.get(taskId);
    if (types?.length === 0) return [];
    const filter = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM events WHERE task_id = ?${filter} ORDER BY sequence`)
      .all(taskId, ...(types ?? []))
      .map(row => {
        const event = parseBoundary(taskEventRow, row, journal('events'));
        return {
          sequence: event.sequence,
          taskId: event.task_id,
          version: event.version,
          at: event.at,
          type: event.type,
          data: parseJson(event.data, journal('events')),
        };
      });
  }

  /** Closes the connection; the store cannot be used afterwards. */
  close(): void {
    this.db.close();
  }

  /** The validated session `id`; throws `RecordNotFoundError` when absent, `BoundaryError` when malformed. */
  session(id: string): Session {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Session', id);
    return record(sessionSchema, 'sessions', row);
  }

  /** Every session, validated (`BoundaryError` on a malformed row), in creation order. */
  sessions(): Session[] {
    return this.db
      .prepare('SELECT state FROM sessions ORDER BY rowid')
      .all()
      .map(row => record(sessionSchema, 'sessions', row));
  }

  /** Inserts or replaces a session record. */
  saveSession(id: string, state: Session): void {
    this.db
      .prepare('INSERT INTO sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  /** Appends a session journal event. */
  appendSession(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO session_events(session_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  /** The session's events, optionally filtered by `types`; throws as {@link session} does. */
  sessionEvents(id: string, types?: readonly string[]): RecordEvent[] {
    this.session(id);
    if (types?.length === 0) return [];
    const filter = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM session_events WHERE session_id = ?${filter} ORDER BY sequence`)
      .all(id, ...(types ?? []))
      .map(row => recordEvent('session_events', row));
  }

  /** Bounded task or planning activity, newest first; cursor ordering does not assert causation. */
  activityEvents(scope: ActivityScope, before: ActivityCursor | null, limit: number): ActivityRecord[] {
    this.activityOwner(scope);
    return readActivity(this.db, scope, before, limit);
  }

  /** All explicitly linked sessions, including planning and completed attempts. */
  activitySessions(scope: ActivityScope): Session[] {
    this.activityOwner(scope);
    return activitySessionIds(this.db, scope).map(sessionId => this.session(sessionId));
  }

  /** Sessions with a recorded tool request, progress or result. */
  activityToolSessions(scope: ActivityScope): string[] {
    this.activityOwner(scope);
    return activityToolSessionIds(this.db, scope);
  }

  private activityOwner(scope: ActivityScope): void {
    if (scope.kind === 'task') this.get(scope.id);
    else this.session(scope.id);
  }

  /** The validated workspace `id`; throws `RecordNotFoundError` when absent, `BoundaryError` when malformed. */
  workspace(id: string): Workspace {
    const row = this.db.prepare('SELECT state FROM workspaces WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Workspace', id);
    return record(workspaceSchema, 'workspaces', row);
  }

  /** Every workspace, validated (`BoundaryError` on a malformed row), in creation order. */
  workspaces(): Workspace[] {
    return this.db
      .prepare('SELECT state FROM workspaces ORDER BY rowid')
      .all()
      .map(row => record(workspaceSchema, 'workspaces', row));
  }

  /**
   * Inserts or replaces a workspace record. The `task_id` and `path_key` columns are unique, so a second
   * workspace for the same task or destination fails with a SQLite constraint error.
   */
  saveWorkspace(id: string, taskId: string, pathKey: string, state: Workspace): void {
    this.db
      .prepare(
        'INSERT INTO workspaces(id, task_id, path_key, state) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path_key = excluded.path_key, state = excluded.state',
      )
      .run(id, taskId, pathKey, JSON.stringify(state));
  }

  /** Appends a workspace journal event. */
  appendWorkspace(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO workspace_events(workspace_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  /** The workspace's events in sequence order; throws as {@link workspace} does. */
  workspaceEvents(id: string): RecordEvent[] {
    this.workspace(id);
    return this.db
      .prepare('SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
      .all(id)
      .map(row => recordEvent('workspace_events', row));
  }

  /** The validated execution `id`; throws `RecordNotFoundError` when absent, `BoundaryError` when malformed. */
  execution(id: string): Execution {
    const row = this.db.prepare('SELECT state FROM executions WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Execution', id);
    return record(executionSchema, 'executions', row);
  }

  /** The execution bound to session `id` (at most one; the column is unique), or null when there is none. */
  executionForSession(id: string): Execution | null {
    const row = this.db.prepare('SELECT state FROM executions WHERE session_id = ?').get(id);
    return row ? record(executionSchema, 'executions', row) : null;
  }

  /** Every execution, or only `taskId`'s, validated (`BoundaryError` on a malformed row), in creation order. */
  executions(taskId?: string): Execution[] {
    const filter = taskId === undefined ? '' : ' WHERE task_id = ?';
    return this.db
      .prepare(`SELECT state FROM executions${filter} ORDER BY rowid`)
      .all(...(taskId === undefined ? [] : [taskId]))
      .map(row => record(executionSchema, 'executions', row));
  }

  /**
   * Inserts or replaces an execution record. Only `state` is updated on conflict: the task, workspace
   * and session an execution is bound to are fixed when it is first saved.
   */
  saveExecution(id: string, taskId: string, workspaceId: string, sessionId: string, state: Execution): void {
    this.db
      .prepare(
        'INSERT INTO executions(id, task_id, workspace_id, session_id, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, taskId, workspaceId, sessionId, JSON.stringify(state));
  }

  /** Appends an execution journal event. */
  appendExecution(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO execution_events(execution_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  /** The execution's events in sequence order, optionally filtered; throws as {@link execution} does. */
  executionEvents(id: string, types?: readonly string[]): RecordEvent[] {
    this.execution(id);
    if (types?.length === 0) return [];
    const filter = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM execution_events WHERE execution_id = ?${filter} ORDER BY sequence`)
      .all(id, ...(types ?? []))
      .map(row => recordEvent('execution_events', row));
  }

  /** The validated lease currently held on the workspace, or null when no operation owns it. */
  lease(workspaceId: string): ExecutionLease | null {
    const row = this.db.prepare('SELECT state FROM execution_leases WHERE workspace_id = ?').get(workspaceId);
    return row ? record(executionLeaseSchema, 'execution_leases', row) : null;
  }

  /** The validated check `id`; throws `RecordNotFoundError` when absent, `BoundaryError` when malformed. */
  check(id: string): RepositoryCheck {
    const row = this.db.prepare('SELECT state FROM checks WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Check', id);
    return record(repositoryCheckSchema, 'checks', row);
  }

  /** The execution's checks, validated, in creation order. */
  checks(executionId: string): RepositoryCheck[] {
    return this.db
      .prepare('SELECT state FROM checks WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(repositoryCheckSchema, 'checks', row));
  }

  /**
   * Display-only check history in creation order. SQLite removes snapshots before crossing into
   * JavaScript, so dashboard caches never materialise a repository copy for every historical check.
   * Evidence and recovery callers must use `check` or `checks` for the complete validated records.
   */
  checkSummaries(executionId: string): CheckSummary[] {
    return this.db
      .prepare(
        "SELECT json_remove(state, '$.before', '$.after') AS state FROM checks WHERE execution_id = ? ORDER BY rowid",
      )
      .all(executionId)
      .map(row => record(checkSummarySchema, 'checks', row));
  }

  /**
   * Recent measured durations for checks starting from the same repository and base. Only compact
   * scalar columns are read; historical snapshots and output never enter a planner's context.
   */
  checkTimings(repository: string, base: string) {
    const rowSchema = z.object({ name: z.string(), milliseconds: z.number(), timedOut: z.number() });
    return this.db
      .prepare(
        `
      SELECT json_extract(c.state, '$.spec.name') name,
        MAX(json_extract(c.state, '$.result.elapsedMs')) milliseconds,
        MAX(CASE WHEN json_extract(c.state, '$.result.reason') = 'timed_out' THEN 1 ELSE 0 END) timedOut
      FROM checks c JOIN executions e ON e.id = c.execution_id JOIN workspaces w ON w.id = e.workspace_id
      WHERE json_extract(w.state, '$.repository') = ? AND json_extract(w.state, '$.baseCommit') = ?
        AND json_extract(c.state, '$.result.elapsedMs') IS NOT NULL
        AND json_extract(c.state, '$.result.exitConfirmed') = 1
      GROUP BY json_extract(c.state, '$.spec.file'), json_extract(c.state, '$.spec.args')
      ORDER BY MAX(c.rowid) DESC LIMIT ?
    `,
      )
      .all(repository, base, planLimits.timingExamples)
      .map(row => rowSchema.parse(row));
  }

  /** Inserts or replaces a check record. */
  saveCheck(id: string, executionId: string, state: RepositoryCheck): void {
    this.db
      .prepare(
        'INSERT INTO checks(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  /**
   * Takes the workspace lease for one run. A plain insert, not an upsert: the workspace, execution and
   * run columns are unique, so while any lease is held a second acquisition fails with a SQLite
   * constraint error instead of silently taking over. That is the fence giving each workspace a single
   * owner.
   */
  acquireLease(workspaceId: string, executionId: string, runId: string, state: ExecutionLease): void {
    this.db
      .prepare('INSERT INTO execution_leases(workspace_id, execution_id, run_id, state) VALUES (?, ?, ?, ?)')
      .run(workspaceId, executionId, runId, JSON.stringify(state));
  }

  /** The validated delivery `id`; throws `RecordNotFoundError` when absent, `BoundaryError` when malformed. */
  delivery(id: string): Delivery {
    const row = this.db.prepare('SELECT state FROM deliveries WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Delivery', id);
    return record(deliverySchema, 'deliveries', row);
  }

  /**
   * The validated implementation run `id`; throws `RecordNotFoundError` when absent, `BoundaryError`
   * when malformed.
   */
  implementation(id: string): ImplementationRun {
    const row = this.db.prepare('SELECT state FROM implementations WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Implementation run', id);
    return record(implementationRunSchema, 'implementations', row);
  }

  /** The execution's implementation runs, validated, in creation order. */
  implementations(executionId: string): ImplementationRun[] {
    return this.db
      .prepare('SELECT state FROM implementations WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(implementationRunSchema, 'implementations', row));
  }

  /** Inserts or replaces an implementation run record. */
  saveImplementation(id: string, executionId: string, state: ImplementationRun): void {
    this.db
      .prepare(
        'INSERT INTO implementations(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  /** The execution's deliveries, validated, in creation order. */
  deliveries(executionId: string): Delivery[] {
    return this.db
      .prepare('SELECT state FROM deliveries WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(deliverySchema, 'deliveries', row));
  }

  /** Inserts or replaces a delivery record. */
  saveDelivery(id: string, executionId: string, state: Delivery): void {
    this.db
      .prepare(
        'INSERT INTO deliveries(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  /** The latest integration health result, validated, or null before the first check. */
  health(): HealthReport | null {
    const row = this.db.prepare('SELECT state FROM health WHERE id = ?').get(latestHealth);
    return row ? record(healthReportSchema, 'health', row) : null;
  }

  /** Replace the latest integration health result. */
  saveHealth(report: HealthReport): void {
    this.db
      .prepare('INSERT INTO health(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(latestHealth, JSON.stringify(report));
  }

  /**
   * The sessions of the task whose delivery was most recently accepted, in creation order: the provider
   * programs that last carried a task through to a verified commit. Null before any delivery.
   */
  lastDelivery(): { taskId: string; deliveryId: string; sessions: Session[] } | null {
    const row = this.db
      .prepare(
        `SELECT executions.task_id AS task_id, deliveries.id AS id FROM deliveries
      JOIN executions ON executions.id = deliveries.execution_id
      WHERE json_extract(deliveries.state, '$.phase') = 'delivered' ORDER BY deliveries.rowid DESC LIMIT 1`,
      )
      .get();
    if (!row) return null;
    const delivered = parseBoundary(z.object({ task_id: z.string(), id: z.string() }), row, journal('deliveries'));
    const sessions = this.db
      .prepare(
        `SELECT sessions.state AS state FROM sessions JOIN executions ON executions.session_id = sessions.id
      WHERE executions.task_id = ? ORDER BY sessions.rowid`,
      )
      .all(delivered.task_id)
      .map(item => record(sessionSchema, 'sessions', item));
    return { taskId: delivered.task_id, deliveryId: delivered.id, sessions };
  }

  /**
   * Running or stopping provider sessions and running checks of live (not deleted) guided tasks whose
   * status is `running`, with the time of the latest event in their own journal (session events for a
   * session, execution events for a check). Stall detection reads this; it is an observation, not
   * ownership.
   */
  activeGuidedWork(): ActiveWork[] {
    const live = `json_type(tasks.state, '$.guided') = 'object' AND json_extract(tasks.state, '$.deletedAt') IS NULL
      AND json_extract(tasks.state, '$.guided.status') = 'running'`;
    const sessions = this.db
      .prepare(
        `SELECT executions.task_id AS task_id, sessions.id AS id, json_extract(sessions.state, '$.provider') AS label,
        NULL AS directory,
        (SELECT at FROM session_events WHERE session_id = sessions.id ORDER BY sequence DESC LIMIT 1) AS last
      FROM sessions JOIN executions ON executions.session_id = sessions.id JOIN tasks ON tasks.id = executions.task_id
      WHERE json_extract(sessions.state, '$.phase') IN ('running', 'stop_requested') AND ${live} ORDER BY sessions.rowid`,
      )
      .all();
    const checks = this.db
      .prepare(
        `SELECT executions.task_id AS task_id, checks.id AS id, json_extract(checks.state, '$.spec.name') AS label,
        json_extract(checks.state, '$.receipt.directory') AS directory,
        (SELECT at FROM execution_events WHERE execution_id = checks.execution_id ORDER BY sequence DESC LIMIT 1) AS last
      FROM checks JOIN executions ON executions.id = checks.execution_id JOIN tasks ON tasks.id = executions.task_id
      WHERE json_extract(checks.state, '$.phase') = 'running' AND ${live} ORDER BY checks.rowid`,
      )
      .all();
    const read = (kind: ActiveWork['kind']) => (row: unknown) => {
      const item = parseBoundary(activeWorkRow, row, journal(kind === 'session' ? 'sessions' : 'checks'));
      return {
        taskId: item.task_id,
        kind,
        id: item.id,
        label: item.label === null ? kind : text(item.label),
        lastEventAt: item.last,
        directory: item.directory,
      };
    };
    return [...sessions.map(read('session')), ...checks.map(read('check'))];
  }

  /**
   * Releases the lease only if it is still held by exactly this workspace, execution and run. Throws
   * otherwise, so a caller whose lease was taken over (for example by recovery) cannot release the
   * new owner's lease.
   */
  releaseLease(workspaceId: string, executionId: string, runId: string): void {
    const result = this.db
      .prepare('DELETE FROM execution_leases WHERE workspace_id = ? AND execution_id = ? AND run_id = ?')
      .run(workspaceId, executionId, runId);
    if (result.changes !== 1) throw new Error('Execution lease no longer matches this run');
  }
  /** Every durable comparison, in creation order. */
  comparisons(): Comparison[] {
    return this.db
      .prepare('SELECT state FROM comparisons ORDER BY rowid')
      .all()
      .map(row => record(comparisonSchema, 'comparisons', row));
  }

  /** A validated comparison, refusing an unknown identity. */
  comparison(id: string): Comparison {
    const row = this.db.prepare('SELECT state FROM comparisons WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Comparison', id);
    return record(comparisonSchema, 'comparisons', row);
  }

  /** Saves comparison state; callers journal its change in the same transaction. */
  saveComparison(value: Comparison): void {
    comparisonSchema.parse(value);
    this.db
      .prepare('INSERT INTO comparisons(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(value.id, JSON.stringify(value));
  }

  /** Appends an event to the comparison journal. */
  appendComparison(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO comparison_events(comparison_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  /** Complete comparison history in durable order. */
  comparisonEvents(id: string): RecordEvent[] {
    this.comparison(id);
    return this.db
      .prepare('SELECT sequence, at, type, data FROM comparison_events WHERE comparison_id = ? ORDER BY sequence')
      .all(id)
      .map(row => recordEvent('comparison_events', row));
  }
}
