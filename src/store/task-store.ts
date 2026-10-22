// One folder per task under `<dataDir>/tasks/<taskId>/`: `events.jsonl` (append-only, written only by the
// task's driver and by `grampus new`), `commands.jsonl` (user decisions, appended by any client) and the
// files workers and checks produce. Appends are single writes of one line, so a crash can tear at most
// the line being written. A torn line never parses, so readers skip it: that event was not recorded and
// its step is redone, which is safe because every Orca mutation is idempotent by request id.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  eventSchemaVersion,
  userCommandSchema,
  type StoredEvent,
  type TaskEvent,
  type UserCommand,
} from '../domain/events.js';

/** File access for one task. */
export class TaskStore {
  readonly eventsPath: string;
  readonly commandsPath: string;

  /** Checked before every append; a driver uses it to stop writing once it no longer holds its lock. */
  private fence: (() => void) | null = null;

  private constructor(readonly dir: string) {
    this.eventsPath = join(dir, 'events.jsonl');
    this.commandsPath = join(dir, 'commands.jsonl');
  }

  /** Create a new task folder and write the log header. Refuses an existing task. */
  static create(dataDir: string, taskId: string): TaskStore {
    const store = new TaskStore(taskDirectory(dataDir, taskId));
    if (existsSync(store.eventsPath)) throw new Error(`Task ${taskId} already exists.`);
    mkdirSync(store.dir, { recursive: true });
    store.append({ type: 'log.header', schema: eventSchemaVersion });
    return store;
  }

  /** Open an existing task, refusing logs written with another schema. */
  static open(dataDir: string, taskId: string): TaskStore {
    const store = new TaskStore(taskDirectory(dataDir, taskId));
    if (!existsSync(store.eventsPath)) throw new Error(`Task ${taskId} was not found in ${dataDir}.`);
    const [header] = store.events();
    if (header?.type !== 'log.header' || header.schema !== eventSchemaVersion)
      throw new Error(`Task ${taskId} was written by another Grampus version; its log is not readable.`);
    return store;
  }

  /** Run `check` before every later append. It throws to refuse the write. */
  fenceWith(check: () => void): void {
    this.fence = check;
  }

  /** Append one event with the current time and return it as stored. */
  append(event: TaskEvent): StoredEvent {
    this.fence?.();
    const stored: StoredEvent = { ...event, at: new Date().toISOString() };
    appendRecord(this.eventsPath, stored);
    return stored;
  }

  events(): StoredEvent[] {
    return readRecords(this.eventsPath) as StoredEvent[];
  }

  /** Queue a user command for the driver. */
  addCommand(command: UserCommand): void {
    appendRecord(this.commandsPath, userCommandSchema.parse(command));
  }

  /** Every queued command. Invalid ones are refused: a client wrote something the driver cannot apply. */
  commands(): UserCommand[] {
    if (!existsSync(this.commandsPath)) return [];
    return readRecords(this.commandsPath).map(record => userCommandSchema.parse(record));
  }

  /** Folder for one dispatch's files, such as a spec draft or a review report. */
  stageDir(key: string): string {
    const dir = join(this.dir, 'stages', safeName(key));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Folder for one check run's logs. */
  checksDir(phase: string, round: number): string {
    const dir = join(this.dir, 'checks', `${phase}-${round}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** Task ids in the data directory, oldest first by id. */
export function listTaskIds(dataDir: string): string[] {
  const root = join(dataDir, 'tasks');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'events.jsonl')))
    .map(entry => entry.name)
    .sort();
}

function taskDirectory(dataDir: string, taskId: string): string {
  if (!/^[a-z0-9-]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  return join(dataDir, 'tasks', taskId);
}

/** A file-system-safe name for a stage key such as `repair:2`. */
export function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]+/g, '-');
}

/**
 * Append one JSON record as a line. A line torn by a crash is ended first, so this record gets a line of
 * its own instead of being glued to the fragment, which would make both unreadable.
 */
export function appendRecord(path: string, record: unknown): void {
  appendFileSync(path, `${endsTorn(path) ? '\n' : ''}${JSON.stringify(record)}\n`);
}

/**
 * The records of a JSON Lines file. Every record is one JSON object and no strict prefix of an object
 * parses, so a line that does not parse is a torn append and is skipped.
 */
export function readRecords(path: string): unknown[] {
  const records: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn append: never recorded.
    }
  }
  return records;
}

/** Whether a file's last line lacks its newline, as a crash during an append leaves it. */
function endsTorn(path: string): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  const handle = openSync(path, 'r');
  try {
    readSync(handle, last, 0, 1, size - 1);
  } finally {
    closeSync(handle);
  }
  return last[0] !== newline;
}

const newline = 0x0a;
