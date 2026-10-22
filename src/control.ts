// Queueing user decisions for a task's driver. The CLI, a chat agent and the dashboard all go through
// here, so every client controls a task the same way: by appending to its command queue.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { userCommandSchema, type UserCommand } from './domain/events.js';
import { foldEvents } from './pipeline/state.js';
import { TaskStore } from './store/task-store.js';

/** Who queued a command. A chat agent acting for the user is `chat`. */
export type CommandSource = UserCommand['source'];

/** A command as a client describes it, before it gets an id, a time and a source. */
export type CommandBody = DistributiveOmit<UserCommand, 'id' | 'at' | 'source'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Validate a command and append it to the task's queue. Throws for an unknown task or a body the
 * driver could not apply; the driver may still refuse a valid command that does not fit the task's state.
 */
export function queueCommand(dataDir: string, taskId: string, source: CommandSource, body: unknown): UserCommand {
  const store = TaskStore.open(dataDir, taskId);
  const fields = typeof body === 'object' && body !== null ? body : {};
  const command = userCommandSchema.parse({ ...fields, id: randomUUID(), at: new Date().toISOString(), source });
  store.addCommand(command);
  return command;
}

/** The spec version an approval names: the given one, or the latest. */
export function approvedVersion(dataDir: string, taskId: string, version: string | undefined): number {
  if (version) return Number(version);
  const latest = foldEvents(TaskStore.open(dataDir, taskId).events()).specs.at(-1);
  if (!latest) throw new Error(`Task ${taskId} has no spec yet.`);
  return latest.version;
}

/** The command line that runs this CLI against a data directory, for driver terminals and skills. */
export function selfCommand(dataDir: string): string {
  return `node "${resolve(process.argv[1] ?? '')}" --home "${dataDir}"`;
}
