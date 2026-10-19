// Owns the SQLite journal: the single current schema, transactions and record access. Rows are parsed
// with zod at this boundary; execution-layer records are validated against persistence/records.ts.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { defaultDataDirectory } from '../config/runtime.js';
import { processLimits } from '../config/limits.js';
import { parseBoundary, parseJson, validateInPlace } from '../process/boundary.js';
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
  CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
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
`;
const expectedTables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].flatMap(match => (match[1] ? [match[1]] : []));

// Row shapes as SQLite returns them. These pin the columns this module selects.
const stateRow = z.object({ state: z.string() });
const eventRow = z.object({ sequence: z.number(), at: z.string(), type: z.string(), data: z.string() });
const taskEventRow = eventRow.extend({ task_id: z.string(), version: z.number() });
const nameRow = z.object({ name: z.string() });
const summaryRow = z.object({ id: z.string(), title: z.unknown(), status: z.unknown(), stage: z.unknown() });

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

  releaseLease(workspaceId: string, executionId: string, runId: string): void {
    const result = this.db
      .prepare('DELETE FROM execution_leases WHERE workspace_id = ? AND execution_id = ? AND run_id = ?')
      .run(workspaceId, executionId, runId);
    if (result.changes !== 1) throw new Error('Execution lease no longer matches this run');
  }
}
