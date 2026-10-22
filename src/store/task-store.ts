// One folder per task under `<dataDir>/tasks/<taskId>/`: `events.jsonl` (append-only, written only by the
// task's driver and by `grampus new`), `commands.jsonl` (user decisions, appended by any client) and the
// files workers and checks produce. Appends are single writes of one line, so a crash can tear at most
// the final line, which readers ignore: that event was not recorded and its step is redone, which is safe
// because every Orca mutation is idempotent by request id.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

  /** Append one event with the current time and return it as stored. */
  append(event: TaskEvent): StoredEvent {
    const stored: StoredEvent = { ...event, at: new Date().toISOString() };
    appendFileSync(this.eventsPath, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  events(): StoredEvent[] {
    return readLines(this.eventsPath).map(line => JSON.parse(line) as StoredEvent);
  }

  /** Queue a user command for the driver. */
  addCommand(command: UserCommand): void {
    appendFileSync(this.commandsPath, `${JSON.stringify(userCommandSchema.parse(command))}\n`);
  }

  /** Every queued command. Invalid lines are refused: a client wrote something the driver cannot apply. */
  commands(): UserCommand[] {
    if (!existsSync(this.commandsPath)) return [];
    return readLines(this.commandsPath).map(line => userCommandSchema.parse(JSON.parse(line)));
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

/** Complete lines of a file. A final line without its newline is a torn append and is ignored. */
export function readLines(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  lines.pop();
  return lines.filter(line => line.trim() !== '');
}
