import type { Session } from './sessions.js';

interface Event { at: string; type: string; data: unknown }

/** Current owned turn only; never expose partial replies, tool results or prompts. */
export function agentProgress(events: Event[], session: Session, purpose: 'planner' | 'implementation' | 'review' = 'planner') {
  if (!session.run) return null;
  const runId = session.run.id;
  const current = events.filter(event => (event.data as { runId?: string } | null)?.runId === runId);
  const started = current.find(event => event.type === 'turn.requested');
  if (!started) return null;
  let stage: 'connecting' | 'working' | 'responding' | 'finishing' | 'stopping' = 'connecting';
  let activity = 'Starting the agent and connecting integrations';
  let lastActivityAt = started.at, repositoryCalls = 0, integrationCalls = 0, fileRequests = 0;
  const recent: { at: string; label: string }[] = [];
  const brief = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, 180) : '';
  const repositoryAction = (tool: unknown, args: Record<string, unknown>, complete: boolean) => {
    const prefix = args.root && args.root !== 'task' ? `${brief(args.root)}/` : '';
    switch (tool) {
      case 'grampus_read_file': return `${complete ? 'Read' : 'Reading'} ${prefix}${brief(args.path) || 'repository file'}`;
      case 'grampus_read_changes': return `${complete ? 'Read' : 'Reading'} changes${args.path ? ` in ${prefix}${brief(args.path)}` : ''}`;
      case 'grampus_list_files': return `${complete ? 'Listed' : 'Listing'} ${prefix || 'repository '}files${args.query ? ` matching “${brief(args.query)}”` : ''}`;
      case 'grampus_search': return `${complete ? 'Searched' : 'Searching'} ${prefix || 'repository'}${args.query ? ` for “${brief(args.query)}”` : ''}`;
      default: return complete ? 'Read repository context' : 'Reading repository context';
    }
  };
  let repositoryRequest: Record<string, unknown> = {};
  for (const event of current) {
    const data = (event.data as { data?: Record<string, unknown> }).data ?? {};
    let label: string | null = null;
    switch (event.type) {
      case 'session.connected': activity = 'Connected to the agent'; break;
      case 'turn.started': stage = 'working'; activity = 'Agent is working on your request'; break;
      case 'repository.tool_requested':
        stage = 'working'; repositoryRequest = { ...(data.arguments as Record<string, unknown> ?? {}), ...(data.root ? { root: data.root } : {}) };
        activity = repositoryAction(data.tool, repositoryRequest, false); break;
      case 'repository.tool_result': {
        stage = 'working'; repositoryCalls++;
        const result = (data.result as Record<string, unknown>) ?? {};
        label = repositoryAction(data.tool, { ...repositoryRequest, ...result, ...(data.root ? { root: data.root } : {}) }, true);
        activity = 'Agent is working with the retrieved context'; break;
      }
      case 'integration.tool_authorized':
        stage = 'working'; integrationCalls++;
        label = `Requested ${brief(data.tool).replace(/^mcp__/, '').replaceAll('__', ' · ') || 'integration tool'}`;
        activity = label; break;
      case 'tool.authorized': {
        stage = 'working';
        const paths = Array.isArray(data.paths) ? data.paths.map(brief).filter(Boolean).slice(0, 3).join(', ') : brief(data.path);
        const editing = ['apply_patch', 'Write', 'Edit', 'mcp__grampus_files__delete_file'].includes(String(data.tool));
        if (editing) fileRequests++;
        label = `${editing ? 'Requested file changes' : 'Requested file access'}${paths ? `: ${paths}` : ''}`;
        activity = label; break;
      }
      case 'tool.deleted': stage = 'working'; label = `Deleted ${brief(data.path) || 'authorized file'}`; activity = label; break;
      case 'output.delta': stage = 'responding'; activity = `Writing the ${purpose} response`; break;
      case 'turn.result': stage = 'finishing'; activity = `Finishing the ${purpose} response`; break;
      default: continue;
    }
    lastActivityAt = event.at;
    if (label) recent.push({ at: event.at, label });
  }
  if (session.phase === 'stop_requested') { stage = 'stopping'; activity = 'Waiting for the agent to stop safely'; }
  return { runId, startedAt: started.at, lastActivityAt, stage, activity, repositoryCalls, integrationCalls, fileRequests, recent: recent.slice(-4) };
}

export function plannerProgress(events: Event[], session: Session) {
  return agentProgress(events, session, 'planner');
}
