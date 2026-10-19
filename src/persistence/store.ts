// Owns the SQLite journal: the single current schema, transactions and record access. Rows are parsed
// with zod at this boundary; execution-layer records are validated against persistence/records.ts.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { defaultDataDirectory } from '../config/runtime.js';
import { processLimits } from '../config/limits.js';
import { BoundaryError, parseBoundary, parseJson, validateInPlace } from '../process/boundary.js';
import { repositorySnapshotSchema, type RepositorySnapshot } from '../repository/snapshot-schema.js';
import { RecordNotFoundError } from './errors.js';
import {
  deliverySchema,
  executionLeaseSchema,
  executionSchema,
  implementationRunSchema,
  repositoryCheckSchema,
  sessionSchema,
  workspaceSchema,
  type Delivery,
  type Execution,
  type ExecutionLease,
  type ImplementationRun,
  type RepositoryCheck,
  type Session,
  type Workspace,
} from './records.js';
import { healthReportSchema, type HealthReport } from '../health/health-record.js';

/** The default journal for this installed or development copy. */
export function defaultDatabasePath(): string {
  return join(defaultDataDirectory(), 'grampus.sqlite');
}

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

const schemaVersion = 1;
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
  return current === schemaVersion && expectedTables.every(table => tables.has(table)) ? 'current' : 'foreign';
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
 * Execution-layer records (sessions, executions, leases, workspaces, checks, implementations and
 * deliveries) are validated on every read against persistence/records.ts and returned with their
 * schema type. Their accessors keep an unused type parameter only so call sites written against the
 * earlier generic API still compile; it has no effect on the result. Task records (including guided
 * state) belong to domain/ and orchestration/: `get` and `list` return them unvalidated, and those
 * modules validate the fields they read.
 */
export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;
  private transactionDepth = 0;

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
        if (state === 'empty') this.db.exec(`${schema} PRAGMA user_version = ${schemaVersion};`);
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
   * A task record. Not validated here: the task and guided state contracts are owned by domain/ and
   * orchestration/, which validate what they read. `T` is the caller's view of that record.
   */
  get<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Task', id);
    // The owning module states the record type; see the class comment.
    return document('tasks', row) as T;
  }

  /** Every task record, in creation order. Not validated here; see `get`. */
  list<T>(): T[] {
    return (
      this.db
        .prepare('SELECT state FROM tasks ORDER BY rowid')
        .all()
        // The owning module states the record type; see the class comment.
        .map(row => document('tasks', row) as T)
    );
  }

  /** Includes commits from other controller connections and writes on this one. */
  revision(): string {
    const data = z.object({ data_version: z.number() }).parse(this.db.prepare('PRAGMA data_version').get());
    const changes = z.object({ changes: z.number() }).parse(this.db.prepare('SELECT total_changes() AS changes').get());
    return `${data.data_version}:${changes.changes}`;
  }

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

  /** The stored snapshot of `artifact`, validated, or null when none was stored. */
  snapshot(artifact: string): RepositorySnapshot | null {
    const row = this.db.prepare('SELECT state FROM snapshots WHERE artifact = ?').get(artifact);
    if (!row) return null;
    const snapshot = record(repositorySnapshotSchema, 'snapshots', row);
    if (snapshot.artifact !== artifact)
      throw new BoundaryError(journal('snapshots'), ['artifact'], 'Stored snapshot does not match its artifact digest');
    return snapshot;
  }

  save(id: string, state: unknown): void {
    this.db
      .prepare('INSERT INTO tasks(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  append(taskId: string, version: number, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO events(task_id, version, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, version, new Date().toISOString(), type, JSON.stringify(data));
  }

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

  close(): void {
    this.db.close();
  }

  session<_Compatible = Session>(id: string): Session {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Session', id);
    return record(sessionSchema, 'sessions', row);
  }

  sessions<_Compatible = Session>(): Session[] {
    return this.db
      .prepare('SELECT state FROM sessions ORDER BY rowid')
      .all()
      .map(row => record(sessionSchema, 'sessions', row));
  }

  saveSession(id: string, state: Session): void {
    this.db
      .prepare('INSERT INTO sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  appendSession(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO session_events(session_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  sessionEvents(id: string, types?: readonly string[]): RecordEvent[] {
    this.session(id);
    if (types?.length === 0) return [];
    const filter = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM session_events WHERE session_id = ?${filter} ORDER BY sequence`)
      .all(id, ...(types ?? []))
      .map(row => recordEvent('session_events', row));
  }

  workspace<_Compatible = Workspace>(id: string): Workspace {
    const row = this.db.prepare('SELECT state FROM workspaces WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Workspace', id);
    return record(workspaceSchema, 'workspaces', row);
  }

  workspaces<_Compatible = Workspace>(): Workspace[] {
    return this.db
      .prepare('SELECT state FROM workspaces ORDER BY rowid')
      .all()
      .map(row => record(workspaceSchema, 'workspaces', row));
  }

  saveWorkspace(id: string, taskId: string, pathKey: string, state: Workspace): void {
    this.db
      .prepare(
        'INSERT INTO workspaces(id, task_id, path_key, state) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path_key = excluded.path_key, state = excluded.state',
      )
      .run(id, taskId, pathKey, JSON.stringify(state));
  }

  appendWorkspace(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO workspace_events(workspace_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  workspaceEvents(id: string): RecordEvent[] {
    this.workspace(id);
    return this.db
      .prepare('SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
      .all(id)
      .map(row => recordEvent('workspace_events', row));
  }

  execution<_Compatible = Execution>(id: string): Execution {
    const row = this.db.prepare('SELECT state FROM executions WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Execution', id);
    return record(executionSchema, 'executions', row);
  }

  executionForSession<_Compatible = Execution>(id: string): Execution | null {
    const row = this.db.prepare('SELECT state FROM executions WHERE session_id = ?').get(id);
    return row ? record(executionSchema, 'executions', row) : null;
  }

  executions<_Compatible = Execution>(): Execution[] {
    return this.db
      .prepare('SELECT state FROM executions ORDER BY rowid')
      .all()
      .map(row => record(executionSchema, 'executions', row));
  }

  saveExecution(id: string, taskId: string, workspaceId: string, sessionId: string, state: Execution): void {
    this.db
      .prepare(
        'INSERT INTO executions(id, task_id, workspace_id, session_id, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, taskId, workspaceId, sessionId, JSON.stringify(state));
  }

  appendExecution(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO execution_events(execution_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  executionEvents(id: string): RecordEvent[] {
    this.execution(id);
    return this.db
      .prepare('SELECT * FROM execution_events WHERE execution_id = ? ORDER BY sequence')
      .all(id)
      .map(row => recordEvent('execution_events', row));
  }

  lease<_Compatible = ExecutionLease>(workspaceId: string): ExecutionLease | null {
    const row = this.db.prepare('SELECT state FROM execution_leases WHERE workspace_id = ?').get(workspaceId);
    return row ? record(executionLeaseSchema, 'execution_leases', row) : null;
  }

  check<_Compatible = RepositoryCheck>(id: string): RepositoryCheck {
    const row = this.db.prepare('SELECT state FROM checks WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Check', id);
    return record(repositoryCheckSchema, 'checks', row);
  }

  checks<_Compatible = RepositoryCheck>(executionId: string): RepositoryCheck[] {
    return this.db
      .prepare('SELECT state FROM checks WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(repositoryCheckSchema, 'checks', row));
  }

  saveCheck(id: string, executionId: string, state: RepositoryCheck): void {
    this.db
      .prepare(
        'INSERT INTO checks(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  acquireLease(workspaceId: string, executionId: string, runId: string, state: ExecutionLease): void {
    this.db
      .prepare('INSERT INTO execution_leases(workspace_id, execution_id, run_id, state) VALUES (?, ?, ?, ?)')
      .run(workspaceId, executionId, runId, JSON.stringify(state));
  }

  delivery<_Compatible = Delivery>(id: string): Delivery {
    const row = this.db.prepare('SELECT state FROM deliveries WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Delivery', id);
    return record(deliverySchema, 'deliveries', row);
  }

  implementation<_Compatible = ImplementationRun>(id: string): ImplementationRun {
    const row = this.db.prepare('SELECT state FROM implementations WHERE id = ?').get(id);
    if (!row) throw new RecordNotFoundError('Implementation run', id);
    return record(implementationRunSchema, 'implementations', row);
  }

  implementations<_Compatible = ImplementationRun>(executionId: string): ImplementationRun[] {
    return this.db
      .prepare('SELECT state FROM implementations WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(implementationRunSchema, 'implementations', row));
  }

  saveImplementation(id: string, executionId: string, state: ImplementationRun): void {
    this.db
      .prepare(
        'INSERT INTO implementations(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  deliveries<_Compatible = Delivery>(executionId: string): Delivery[] {
    return this.db
      .prepare('SELECT state FROM deliveries WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => record(deliverySchema, 'deliveries', row));
  }

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
   * Running provider sessions and checks of live guided tasks whose status is `running`, with the time
   * of the latest event in their own journal (session events for a session, execution events for a
   * check). Stall detection reads this; it is an observation, not ownership.
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

  releaseLease(workspaceId: string, executionId: string, runId: string): void {
    const result = this.db
      .prepare('DELETE FROM execution_leases WHERE workspace_id = ? AND execution_id = ? AND run_id = ?')
      .run(workspaceId, executionId, runId);
    if (result.changes !== 1) throw new Error('Execution lease no longer matches this run');
  }
}
