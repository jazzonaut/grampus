// Owns the live progress summary of an agent's current turn (planner, implementer or reviewer) for the
// dashboard: a stage, a one-line activity and the last few tool actions. It reads only event types and
// bounded excerpts of tool arguments with control characters blanked; it never exposes prompts, partial
// replies or tool results.
import type { Session } from '../execution/sessions.js';
import { serverLimits } from '../config/limits.js';
import { NativeProgress } from './native-progress.js';

/** The fields of a session event this module reads. */
interface Event {
  at: string;
  type: string;
  data: unknown;
}

type Stage = 'connecting' | 'working' | 'responding' | 'finishing' | 'stopping';

/** The own enumerable fields of a plain object, or none for any other value. */
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** C0 controls, DEL and C1 controls: a terminal or log viewer may act on any of them. */
const control = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** A bounded excerpt of a text value with control characters blanked; empty for anything else. */
function brief(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value.slice(0, serverLimits.progressTextCharacters), character =>
        control(character.charCodeAt(0)) ? ' ' : character,
      ).join('')
    : '';
}

const reading = { active: 'Reading', complete: 'Read' } as const;

/**
 * How each repository tool call is described: its verb in progress and once complete, and what it acted on.
 * `prefix` names a reference folder root (`reference-1/`), or is empty for the task repository.
 */
const repositoryActions: Readonly<
  Record<
    string,
    {
      verb: { active: string; complete: string };
      subject: (args: Record<string, unknown>, prefix: string) => string;
    }
  >
> = {
  grampus_read_file: {
    verb: reading,
    subject: (args, prefix) => `${prefix}${brief(args['path']) || 'repository file'}`,
  },
  grampus_read_changes: {
    verb: reading,
    subject: (args, prefix) => `changes${args['path'] ? ` in ${prefix}${brief(args['path'])}` : ''}`,
  },
  grampus_list_files: {
    verb: { active: 'Listing', complete: 'Listed' },
    subject: (args, prefix) =>
      `${prefix || 'repository '}files${args['query'] ? ` matching “${brief(args['query'])}”` : ''}`,
  },
  grampus_search: {
    verb: { active: 'Searching', complete: 'Searched' },
    subject: (args, prefix) => `${prefix || 'repository'}${args['query'] ? ` for “${brief(args['query'])}”` : ''}`,
  },
  grampus_read_check: { verb: reading, subject: () => 'check evidence' },
  grampus_read_dependency: { verb: reading, subject: args => `dependency ${brief(args['package']) || 'source'}` },
  grampus_suggest_reference_folder: {
    verb: { active: 'Suggesting', complete: 'Suggested' },
    subject: args => `reference folder${args['path'] ? ` ${brief(args['path'])}` : ''}`,
  },
};

/** A human description of a repository tool call, in progress or complete. */
function repositoryAction(tool: unknown, args: Record<string, unknown>, complete: boolean): string {
  const prefix = args['root'] && args['root'] !== 'task' ? `${brief(args['root'])}/` : '';
  const action =
    typeof tool === 'string' && Object.hasOwn(repositoryActions, tool) ? repositoryActions[tool] : undefined;
  if (!action) return complete ? 'Read repository context' : 'Reading repository context';
  return `${complete ? action.verb.complete : action.verb.active} ${action.subject(args, prefix)}`;
}

/** Folds the events of one run into its progress. */
class Progress {
  private readonly native = new NativeProgress();
  stage: Stage = 'connecting';
  activity = 'Starting the agent and connecting integrations';
  repositoryCalls = 0;
  integrationCalls = 0;
  fileRequests = 0;
  /** The latest repository request, so its result can be described with the arguments that asked for it. */
  private repositoryRequest: Record<string, unknown> = {};

  constructor(private readonly purpose: 'planner' | 'implementation' | 'review') {}

  /**
   * Applies one event and returns the recent-activity label it adds; null when it adds none, and
   * undefined when the event type is not progress at all.
   */
  apply(type: string, data: Record<string, unknown>): string | null | undefined {
    const observed = this.native.apply(type, data);
    if (observed !== undefined) {
      this.stage = 'working';
      this.activity = this.native.activity ?? 'Agent turn in progress; no tool is currently observed running';
      return observed;
    }
    if (type === 'output.delta' && this.native.activity) {
      this.activity = this.native.activity;
      return null;
    }
    switch (type) {
      case 'session.connected':
        this.activity = 'Connected to the agent';
        return null;
      case 'turn.started':
        this.stage = 'working';
        this.activity = 'Agent is working on your request';
        return null;
      case 'repository.tool_requested':
        this.stage = 'working';
        this.repositoryRequest = { ...fields(data['arguments']), ...(data['root'] ? { root: data['root'] } : {}) };
        this.activity = this.native.activity ?? repositoryAction(data['tool'], this.repositoryRequest, false);
        return null;
      case 'repository.tool_result':
        return this.repositoryResult(data);
      case 'integration.tool_authorized':
        return this.integration(data);
      case 'tool.authorized':
        return this.fileTool(data);
      case 'tool.deleted':
        return this.working(`Deleted ${brief(data['path']) || 'authorized file'}`);
      case 'output.delta':
        this.stage = 'responding';
        this.activity = `Writing the ${this.purpose} response`;
        return null;
      case 'turn.result':
        this.stage = 'finishing';
        this.activity = `Finishing the ${this.purpose} response`;
        return null;
      default:
        return undefined;
    }
  }

  /** A tool action that is itself the current activity. */
  private working(label: string): string {
    this.stage = 'working';
    this.activity = this.native.activity ?? label;
    return label;
  }

  /**
   * A completed repository call, labelled with the arguments of its request. Result fields are merged
   * over them, but the label reads only `root`, `path` and `query`, so result contents never appear.
   */
  private repositoryResult(data: Record<string, unknown>): string {
    this.stage = 'working';
    this.repositoryCalls++;
    const label = repositoryAction(
      data['tool'],
      { ...this.repositoryRequest, ...fields(data['result']), ...(data['root'] ? { root: data['root'] } : {}) },
      true,
    );
    this.activity = this.native.activity ?? 'Agent is working with the retrieved context';
    return label;
  }

  private integration(data: Record<string, unknown>): string {
    this.integrationCalls++;
    return this.working(
      `Requested ${
        brief(data['tool'])
          .replace(/^mcp__/, '')
          .replaceAll('__', ' · ') || 'integration tool'
      }`,
    );
  }

  private fileTool(data: Record<string, unknown>): string {
    const listed = data['paths'];
    const paths = Array.isArray(listed)
      ? listed.map(brief).filter(Boolean).slice(0, 3).join(', ')
      : brief(data['path']);
    const editing = ['apply_patch', 'Write', 'Edit', 'mcp__grampus_files__delete_file'].includes(String(data['tool']));
    if (editing) this.fileRequests++;
    return this.working(`${editing ? 'Requested file changes' : 'Requested file access'}${paths ? `: ${paths}` : ''}`);
  }
}

/**
 * Progress of the session's current owned turn only, or null when no turn is running. Agent events are
 * journaled as `{ runId, data }`; only events of the current run count.
 */
export function agentProgress(
  events: Event[],
  session: Session,
  purpose: 'planner' | 'implementation' | 'review' = 'planner',
) {
  if (!session.run) return null;
  const runId = session.run.id;
  const current = events.filter(event => fields(event.data)['runId'] === runId);
  const started = current.find(event => event.type === 'turn.requested');
  if (!started) return null;
  const progress = new Progress(purpose);
  let lastActivityAt = started.at;
  const recent: { at: string; label: string }[] = [];
  for (const event of current) {
    const label = progress.apply(event.type, fields(fields(event.data)['data']));
    if (label === undefined) continue;
    lastActivityAt = event.at;
    if (label) recent.push({ at: event.at, label });
  }
  if (session.phase === 'stop_requested') {
    progress.stage = 'stopping';
    progress.activity = 'Waiting for the agent to stop safely';
  }
  return {
    runId,
    startedAt: started.at,
    lastActivityAt,
    stage: progress.stage,
    activity: progress.activity,
    repositoryCalls: progress.repositoryCalls,
    integrationCalls: progress.integrationCalls,
    fileRequests: progress.fileRequests,
    recent: recent.slice(-4),
  };
}

/** {@link agentProgress} of a planning turn. */
export function plannerProgress(events: Event[], session: Session) {
  return agentProgress(events, session, 'planner');
}
