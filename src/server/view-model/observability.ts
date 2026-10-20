// Owns task and planning networks, preserving original identities and explicit gaps in journal coverage.
import type { Session, Execution } from '../../persistence/records.js';
import type { Store } from '../../persistence/store.js';
import { activityCursorSchema } from '../../persistence/activity.js';
import { observabilityLimits } from '../../config/limits.js';
import { currentSettings } from '../../config/settings.js';
import type { ActivityNodeV1, ActivitySubjectV1, ObservabilityV1 } from '../api-types.js';
import { HttpError } from '../errors.js';
import {
  activityFields,
  activityCursor,
  baseActivity,
  controllerActivity,
  providerActivity,
} from './activity-events.js';

const coverage = [
  'Observed events come from the controller and provider journals. A tool authorisation does not prove execution or completion.',
  'Backend model activity is provider-reported. Internal inference requests, per-tool tokens and network latency may be unavailable.',
  'Events are displayed by recorded clock time with stable source/sequence tie-breakers. This ordering does not establish causation.',
  'Replay covers the loaded event window. Earlier state is unknown until preceding windows are loaded. Current participant states apply only in live mode.',
  'Previews are bounded and redacted; raw prompts, tool arguments, tool results and files are not exposed by this API.',
];

function cursor(value: string | null) {
  if (value === null) return null;
  try {
    if (value.length > observabilityLimits.cursorCharacters) throw new Error('Cursor too long');
    return activityCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'Invalid activity cursor');
  }
}

/** Bounded read projection; it cannot dispatch a provider, mutate state, approve evidence or replay work. */
export function observabilityView(
  store: Store,
  subject: ActivitySubjectV1,
  before: string | null = null,
  limit: number = observabilityLimits.pageEvents,
): ObservabilityV1 {
  if (!Number.isInteger(limit) || limit < 1 || limit > observabilityLimits.maxPageEvents)
    throw new HttpError(400, 'Invalid activity page size');
  const rows = store.activityEvents(subject, cursor(before), limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const nodes = new Map<string, ActivityNodeV1>([
    [
      'controller',
      {
        id: 'controller',
        kind: 'controller',
        label: 'Grampus controller',
        detail: 'Owns decisions, evidence and recovery',
        status: 'observed',
      },
    ],
  ]);
  const toolSessions = new Set(store.activityToolSessions(subject));
  const sessions = store.activitySessions(subject);
  const sessionRecords = new Map(sessions.map(session => [session.id, session]));
  const executions = new Map(sessions.map(session => [session.id, store.executionForSession(session.id)]));
  for (const session of sessions)
    addSessionNodes(nodes, session, executions.get(session.id), toolSessions.has(session.id));
  const events = page.map(row => {
    const event = baseActivity(subject.kind === 'task' ? subject.id : null, row);
    if (row.origin === 'session' && !row.type.startsWith('kickoff.') && !row.type.startsWith('dashboard.'))
      providerActivity(row, event, { nodes, agentId: `agent:${row.owner}`, modelId: `model:${row.owner}` });
    else controllerActivity(row, event, nodes);
    // Inference is explicit when a provider event lacks the identifiers needed to prove a relationship.
    if (row.type === 'output.delta') event.provenance = 'inferred';
    const fields = activityFields(row.data);
    const session = sessionRecords.get(row.owner);
    if (session)
      Object.assign(event.correlation, { providerSessionId: session.providerSessionId, provider: session.provider });
    const execution = executions.get(row.owner);
    if (execution)
      Object.assign(event.correlation, {
        attemptId: execution.attemptId,
        workspaceId: execution.workspaceId,
        sliceIndex: execution.sliceIndex,
        artifact: execution.artifact,
      });
    if (fields.checkId) event.correlation.resultId = fields.checkId;
    return event;
  });
  return {
    apiVersion: 1,
    subject,
    revision: store.revision(),
    intervalMs: currentSettings().observabilityIntervalMs,
    nodes: [...nodes.values()],
    events,
    before: more && page[0] ? activityCursor(page[0]) : null,
    coverage,
  };
}

function addSessionNodes(
  nodes: Map<string, ActivityNodeV1>,
  session: Session,
  execution: Execution | null | undefined,
  hasTools: boolean,
): void {
  const role = execution?.stage ?? 'planning';
  const provider = session.provider === 'codex' ? 'Codex' : 'Claude';
  const group = `${session.provider}:${execution?.role ?? 'planning'}`;
  const groupLabel = `${provider} ${execution?.role === 'review' ? 'reviewer' : execution ? 'implementer' : 'planner'}`;
  const status =
    session.phase === 'idle' && session.lastReply ? 'completed' : session.phase === 'running' ? 'active' : 'unknown';
  nodes.set(`agent:${session.id}`, {
    id: `agent:${session.id}`,
    kind: 'agent',
    label: `${provider} ${role}`,
    detail: execution?.role ?? 'planning',
    status,
    groupId: `agent:${group}`,
    groupLabel,
  });
  nodes.set(`model:${session.id}`, {
    id: `model:${session.id}`,
    kind: 'model',
    label: `${provider} backend model`,
    detail: 'Provider-reported model connection',
    status: 'unknown',
    groupId: `model:${group}`,
    recorded: session.providerSessionId !== null,
  });
  nodes.set(`tools:${session.id}`, {
    id: `tools:${session.id}`,
    kind: 'tools',
    label: 'Workspace and integration tools',
    detail: 'Select to inspect individual calls and results',
    status: 'unknown',
    groupId: `tools:${group}`,
    recorded: hasTools,
  });
  if (session.providerSessionId !== null) {
    const agent = nodes.get(`agent:${session.id}`),
      model = nodes.get(`model:${session.id}`);
    if (agent) agent.parentId = 'controller';
    if (model) model.parentId = `agent:${session.id}`;
  }
  const tools = nodes.get(`tools:${session.id}`);
  if (tools && hasTools) tools.parentId = `agent:${session.id}`;
}
