// Owns the SQLite journal: the single current schema, transactions and record access.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDataDirectory } from '../config/runtime.js';
import { processLimits } from '../config/limits.js';

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
const expectedTables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]!);

type SchemaState = 'empty' | 'current' | 'foreign';
function schemaState(db: DatabaseSync): SchemaState {
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(row => String(row['name'])),
  );
  if (version === 0 && tables.size === 0) return 'empty';
  return version === schemaVersion && expectedTables.every(table => tables.has(table)) ? 'current' : 'foreign';
}
function refuse(path: string): Error {
  return new Error(
    `This journal was created by an older Grampus version and cannot be opened. Start with a fresh journal (the old file is left untouched): ${path}`,
  );
}

/**
 * All state changes and their evidence are committed in the same transaction.
 *
 * There is one schema version and no migration. A journal from any other version is
 * refused before this connection writes anything to it, so its bytes stay unchanged.
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

  get<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error(`Task not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  list<T>(): T[] {
    return this.db
      .prepare('SELECT state FROM tasks ORDER BY rowid')
      .all()
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  /** Includes commits from other controller connections and writes on this one. */
  revision(): string {
    return `${this.db.prepare('PRAGMA data_version').get()!['data_version']}:${this.db.prepare('SELECT total_changes() AS changes').get()!['changes']}`;
  }

  guidedSummaries(): { id: string; title: string; status: string; stage: string }[] {
    return this.db
      .prepare(
        `SELECT id, json_extract(state, '$.brief.title') AS title,
      json_extract(state, '$.guided.status') AS status, json_extract(state, '$.guided.stage') AS stage
      FROM tasks WHERE json_type(state, '$.guided') = 'object' AND json_extract(state, '$.deletedAt') IS NULL ORDER BY rowid`,
      )
      .all()
      .map(row => ({
        id: String(row['id']),
        title: String(row['title']),
        status: String(row['status']),
        stage: String(row['stage']),
      }));
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
      .map(row => ({
        sequence: Number(row['sequence']),
        taskId: String(row['task_id']),
        version: Number(row['version']),
        at: String(row['at']),
        type: String(row['type']),
        data: JSON.parse(String(row['data'])) as unknown,
      }));
  }

  close(): void {
    this.db.close();
  }

  session<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  sessions<T>(): T[] {
    return this.db
      .prepare('SELECT state FROM sessions ORDER BY rowid')
      .all()
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveSession(id: string, state: unknown): void {
    this.db
      .prepare('INSERT INTO sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  appendSession(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO session_events(session_id, at, type, data) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  sessionEvents(
    id: string,
    types?: readonly string[],
  ): { sequence: number; at: string; type: string; data: unknown }[] {
    this.session(id);
    if (types?.length === 0) return [];
    const filter = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM session_events WHERE session_id = ?${filter} ORDER BY sequence`)
      .all(id, ...(types ?? []))
      .map(row => ({
        sequence: Number(row['sequence']),
        at: String(row['at']),
        type: String(row['type']),
        data: JSON.parse(String(row['data'])) as unknown,
      }));
  }

  workspace<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM workspaces WHERE id = ?').get(id);
    if (!row) throw new Error(`Workspace not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  workspaces<T>(): T[] {
    return this.db
      .prepare('SELECT state FROM workspaces ORDER BY rowid')
      .all()
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveWorkspace(id: string, taskId: string, pathKey: string, state: unknown): void {
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

  workspaceEvents(id: string): { sequence: number; at: string; type: string; data: unknown }[] {
    this.workspace(id);
    return this.db
      .prepare('SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
      .all(id)
      .map(row => ({
        sequence: Number(row['sequence']),
        at: String(row['at']),
        type: String(row['type']),
        data: JSON.parse(String(row['data'])) as unknown,
      }));
  }

  execution<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM executions WHERE id = ?').get(id);
    if (!row) throw new Error(`Execution not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  executionForSession<T>(id: string): T | null {
    const row = this.db.prepare('SELECT state FROM executions WHERE session_id = ?').get(id);
    return row ? (JSON.parse(String(row['state'])) as T) : null;
  }

  executions<T>(): T[] {
    return this.db
      .prepare('SELECT state FROM executions ORDER BY rowid')
      .all()
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveExecution(id: string, taskId: string, workspaceId: string, sessionId: string, state: unknown): void {
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

  executionEvents(id: string): { sequence: number; at: string; type: string; data: unknown }[] {
    this.execution(id);
    return this.db
      .prepare('SELECT * FROM execution_events WHERE execution_id = ? ORDER BY sequence')
      .all(id)
      .map(row => ({
        sequence: Number(row['sequence']),
        at: String(row['at']),
        type: String(row['type']),
        data: JSON.parse(String(row['data'])) as unknown,
      }));
  }

  lease<T>(workspaceId: string): T | null {
    const row = this.db.prepare('SELECT state FROM execution_leases WHERE workspace_id = ?').get(workspaceId);
    return row ? (JSON.parse(String(row['state'])) as T) : null;
  }

  check<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM checks WHERE id = ?').get(id);
    if (!row) throw new Error(`Check not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  checks<T>(executionId: string): T[] {
    return this.db
      .prepare('SELECT state FROM checks WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveCheck(id: string, executionId: string, state: unknown): void {
    this.db
      .prepare(
        'INSERT INTO checks(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  acquireLease(workspaceId: string, executionId: string, runId: string, state: unknown): void {
    this.db
      .prepare('INSERT INTO execution_leases(workspace_id, execution_id, run_id, state) VALUES (?, ?, ?, ?)')
      .run(workspaceId, executionId, runId, JSON.stringify(state));
  }

  delivery<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM deliveries WHERE id = ?').get(id);
    if (!row) throw new Error(`Delivery not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  implementation<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM implementations WHERE id = ?').get(id);
    if (!row) throw new Error(`Implementation run not found: ${id}`);
    return JSON.parse(String(row['state'])) as T;
  }

  implementations<T>(executionId: string): T[] {
    return this.db
      .prepare('SELECT state FROM implementations WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveImplementation(id: string, executionId: string, state: unknown): void {
    this.db
      .prepare(
        'INSERT INTO implementations(id, execution_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(id, executionId, JSON.stringify(state));
  }

  deliveries<T>(executionId: string): T[] {
    return this.db
      .prepare('SELECT state FROM deliveries WHERE execution_id = ? ORDER BY rowid')
      .all(executionId)
      .map(row => JSON.parse(String(row['state'])) as T);
  }

  saveDelivery(id: string, executionId: string, state: unknown): void {
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
