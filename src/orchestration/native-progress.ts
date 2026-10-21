// Owns observational native tool labels and concurrent item tracking for live progress summaries.
import { serverLimits } from '../config/limits.js';
import { sanitiseDetail } from '../health/health.js';

const tools: Readonly<Record<string, { active: string; subject: string }>> = {
  commandExecution: { active: 'Running a command', subject: 'Command' },
  Bash: { active: 'Running a command', subject: 'Command' },
  fileChange: { active: 'Changing files', subject: 'File change' },
  Write: { active: 'Writing a file', subject: 'File write' },
  Edit: { active: 'Editing a file', subject: 'File edit' },
  Read: { active: 'Reading a file', subject: 'File read' },
  Glob: { active: 'Finding files', subject: 'File search' },
  Grep: { active: 'Searching files', subject: 'Content search' },
  webSearch: { active: 'Searching the web', subject: 'Web search' },
  imageView: { active: 'Inspecting an image', subject: 'Image inspection' },
};

/** Folds provider item observations without treating authorisation or request generation as execution. */
export class NativeProgress {
  private readonly active = new Map<string, string>();
  private readonly descriptions = new Map<string, { active: string; subject: string }>();

  /** The latest unfinished tool, or null when no tool execution is observed. */
  get activity(): string | null {
    return [...this.active.values()].at(-1) ?? null;
  }

  /** A tool observation's compact label; model signals return null and unrelated events undefined. */
  apply(type: string, data: Record<string, unknown>): string | null | undefined {
    if (!['activity.started', 'activity.completed', 'activity.progress', 'activity.requested'].includes(type))
      return undefined;
    if (data['kind'] !== 'tool') return null;
    const id = data['id'];
    if (typeof id !== 'string') return undefined;
    const name =
      typeof data['name'] === 'string'
        ? sanitiseDetail(data['name']).slice(0, serverLimits.progressTextCharacters)
        : 'tool';
    const description = this.descriptions.get(id) ??
      (Object.hasOwn(tools, name) ? tools[name] : undefined) ?? { active: `Using ${name}`, subject: name };
    this.descriptions.set(id, description);
    const { active, subject } = description;
    if (type === 'activity.requested') return `${subject} requested`;
    if (type === 'activity.completed') {
      this.active.delete(id);
      const status = data['status'];
      if (status === 'completed') return `${subject} completed`;
      if (status === 'failed' || status === 'interrupted') return `${subject} ${status}`;
      return `${subject} result unknown`;
    }
    this.active.delete(id);
    this.active.set(id, active);
    return type === 'activity.progress' ? active : `${subject} started`;
  }
}
