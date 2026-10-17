import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export function defaultDatabasePath(): string {
  const base = process.env.GRAMPUS_HOME ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Grampus')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Grampus')
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'grampus'));
  return join(base, 'journal.sqlite');
}

export interface JournalEvent {
  sequence: number;
  taskId: string;
  version: number;
  at: string;
  type: string;
  data: unknown;
}

/** All state changes and their evidence are committed in the same transaction. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error(`Unsupported journal schema version: ${version}`);
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        version INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, sequence);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error(`Task not found: ${id}`);
    return JSON.parse(String(row.state)) as T;
  }

  list<T>(): T[] {
    return this.db.prepare('SELECT state FROM tasks ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.state)) as T);
  }

  save(id: string, state: unknown): void {
    this.db.prepare('INSERT INTO tasks(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state));
  }

  append(taskId: string, version: number, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(task_id, version, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, version, new Date().toISOString(), type, JSON.stringify(data));
  }

  events(taskId: string): JournalEvent[] {
    this.get(taskId);
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY sequence').all(taskId)
      .map(row => ({
        sequence: Number(row.sequence), taskId: String(row.task_id), version: Number(row.version),
        at: String(row.at), type: String(row.type), data: JSON.parse(String(row.data)) as unknown,
      }));
  }

  close(): void { this.db.close(); }

  session<T>(id: string): T {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return JSON.parse(String(row.state)) as T;
  }

  sessions<T>(): T[] {
    return this.db.prepare('SELECT state FROM sessions ORDER BY rowid').all().map(row => JSON.parse(String(row.state)) as T);
  }

  saveSession(id: string, state: unknown): void {
    this.db.prepare('INSERT INTO sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state').run(id, JSON.stringify(state));
  }

  appendSession(id: string, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO session_events(session_id, at, type, data) VALUES (?, ?, ?, ?)').run(id, new Date().toISOString(), type, JSON.stringify(data));
  }

  sessionEvents(id: string): { sequence: number; at: string; type: string; data: unknown }[] {
    this.session(id);
    return this.db.prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence').all(id).map(row => ({
      sequence: Number(row.sequence), at: String(row.at), type: String(row.type), data: JSON.parse(String(row.data)) as unknown,
    }));
  }
}
