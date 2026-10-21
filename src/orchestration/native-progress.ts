// Owns observational native tool labels and concurrent item tracking for live progress summaries.
import { serverLimits } from '../config/limits.js';
import { sanitiseDetail } from '../health/health.js';
import { repositoryToolDefinitions } from '../repository/repository-tools.js';

/**
 * Grampus' own repository tools as Codex (bare) and Claude (MCP-prefixed) name them. Their journaled
 * `repository.tool_*` events already carry richer labels, so item observations would only duplicate them.
 */
const grampusTools = new Set(
  repositoryToolDefinitions.flatMap(tool => [tool.name, `mcp__grampus_repository__${tool.name}`]),
);
/** How a tool is described while it runs and after; `detail` is a redacted command preview. */
interface ToolDescription {
  active: string;
  subject: string;
  detail?: string;
}

const tools: Readonly<Record<string, ToolDescription>> = {
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

/** A settled tool's outcome word; anything but a confirmed status is unknown, never success. */
function outcome(status: unknown): string {
  return status === 'completed' || status === 'failed' || status === 'interrupted' ? status : 'result unknown';
}

/** Folds provider item observations without treating authorisation or request generation as execution. */
export class NativeProgress {
  private readonly active = new Map<string, string>();
  private readonly descriptions = new Map<string, ToolDescription>();
  private readonly skipped = new Set<string>();

  /** The latest unfinished tool, or null when no tool execution is observed. */
  get activity(): string | null {
    return [...this.active.values()].at(-1) ?? null;
  }

  /**
   * A tool observation's compact label; model signals return null, and unrelated events and Grampus
   * repository tools (labelled by their own `repository.tool_*` events) return undefined.
   */
  apply(type: string, data: Record<string, unknown>): string | null | undefined {
    if (!['activity.started', 'activity.completed', 'activity.progress', 'activity.requested'].includes(type))
      return undefined;
    if (data['kind'] !== 'tool') return null;
    const id = data['id'];
    if (typeof id !== 'string') return undefined;
    // Claude results carry only the tool id, so a skipped request is remembered by id.
    if (typeof data['name'] === 'string' && grampusTools.has(data['name'])) this.skipped.add(id);
    if (this.skipped.has(id)) return undefined;
    const description = this.describe(id, data);
    const suffix = description.detail ? `: ${description.detail}` : '';
    if (type === 'activity.requested') return `${description.subject} requested${suffix}`;
    if (type === 'activity.completed') {
      this.active.delete(id);
      return `${description.subject} ${outcome(data['status'])}${suffix}`;
    }
    const active = description.detail ? `Running ${description.detail}` : description.active;
    this.active.delete(id);
    this.active.set(id, active);
    return type === 'activity.progress' ? active : `${description.subject} started${suffix}`;
  }

  /**
   * The tool's description, fixed by its first observation. The redacted command preview arrives with
   * the start or request only; later observations repeat just the id, so it is remembered here.
   */
  private describe(id: string, data: Record<string, unknown>): ToolDescription {
    const known = this.descriptions.get(id);
    const detail = typeof data['detail'] === 'string' && data['detail'] ? data['detail'] : undefined;
    if (known && (known.detail || !detail)) return known;
    const name =
      typeof data['name'] === 'string'
        ? sanitiseDetail(data['name']).slice(0, serverLimits.progressTextCharacters)
        : 'tool';
    const base = known ??
      (Object.hasOwn(tools, name) ? tools[name] : undefined) ?? { active: `Using ${name}`, subject: name };
    const description = detail ? { ...base, detail } : base;
    this.descriptions.set(id, description);
    return description;
  }
}
