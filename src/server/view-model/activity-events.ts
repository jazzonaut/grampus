// Owns activity semantics. Endpoint direction and state changes are decided here, never in Vue.
import { z } from 'zod';
import { sanitiseDetail } from '../../health/health.js';
import { observabilityLimits } from '../../config/limits.js';
import type { ActivityRecord } from '../../persistence/activity.js';
import type { ActivityEventV1, ActivityNodeV1, ActivityStatusV1 } from '../api-types.js';
import { timelineEntry } from './timeline.js';

const fieldsSchema = z.object({
  runId: z.string().optional(),
  id: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().nullish(),
  status: z.string().optional(),
  phase: z.string().optional(),
  providerTurnId: z.string().nullish(),
  text: z.string().optional(),
  /** A redacted, shortened command preview recorded by the provider adapter. */
  detail: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  checkId: z.string().optional(),
  deliveryId: z.string().optional(),
  resultId: z.string().optional(),
  durationMs: z.number().nonnegative().nullish(),
  elapsedMs: z.number().nonnegative().nullish(),
  inputTokens: z.number().nonnegative().nullish(),
  outputTokens: z.number().nonnegative().nullish(),
  cachedInputTokens: z.number().nonnegative().nullish(),
  scope: z.string().optional(),
  exitConfirmed: z.boolean().optional(),
  messageId: z.string().nullish(),
  requestId: z.string().nullish(),
  parentItemId: z.string().nullish(),
  artifact: z.string().nullish(),
  error: z.string().nullish(),
  outcome: z.string().nullish(),
  executionId: z.string().optional(),
});
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  result: z.unknown().optional(),
});
const permissionEvents = new Set(['tool.authorized', 'tool.denied', 'integration.tool_authorized']);

/** Only selected text is previewed. Never return raw provider frames, prompts, tool arguments or files. */
export function activityPreview(text: string | undefined): string | null {
  if (!text) return null;
  const clean = sanitiseDetail(text);
  return clean.length > observabilityLimits.previewCharacters
    ? `${clean.slice(0, observabilityLimits.previewCharacters)}… [truncated]`
    : clean;
}

/** Provider states never turn missing confirmation into a successful completion. */
export function activityStatus(value: string | undefined): ActivityStatusV1 {
  if (value === 'completed' || value === 'passed' || value === 'committed' || value === 'no_change') return 'completed';
  if (value === 'failed' || value === 'declined' || value === 'denied') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  if (value === 'inProgress' || value === 'running') return 'active';
  return 'unknown';
}

/** Stable cursor for the original event; timestamps order display, while explicit ids establish relationships. */
export function activityCursor(event: ActivityRecord): string {
  return Buffer.from(JSON.stringify([event.at, event.origin, event.sequence])).toString('base64url');
}

/** Projection context shared by the task and provider event interpreters. */
export interface ActivityContext {
  nodes: Map<string, ActivityNodeV1>;
  agentId: string;
  modelId: string;
}

/** The bounded structural fields used by activity consumers, independent of unknown provider additions. */
export function activityFields(value: unknown): z.infer<typeof fieldsSchema> {
  return fieldsSchema.safeParse(value).data ?? {};
}

/** Creates an event with its source identity before interpreting optional observational fields. */
export function baseActivity(taskId: string | null, row: ActivityRecord): ActivityEventV1 {
  const envelope = envelopeSchema.safeParse(row.data).data;
  const outer = activityFields(row.data),
    data = activityFields(envelope?.data);
  return {
    id: `${row.origin}:${row.sequence}`,
    cursor: activityCursor(row),
    at: row.at,
    type: row.type,
    category: 'controller',
    source: 'controller',
    target: 'controller',
    label: row.type.replaceAll('_', ' '),
    status: 'observed',
    provenance: 'observed',
    preview: activityPreview(data.text ?? data.detail ?? data.reason ?? outer.note ?? outer.reason),
    durationMs: data.durationMs ?? null,
    correlation: {
      taskId,
      version: row.version,
      executionId: row.executionId ?? outer.executionId ?? null,
      sessionId: row.origin === 'session' ? row.owner : null,
      runId: outer.runId ?? null,
      providerTurnId: data.providerTurnId ?? null,
      itemId: data.id ?? null,
      resultId: outer.resultId ?? outer.checkId ?? outer.deliveryId ?? null,
      attemptId: null,
      workspaceId: null,
      sliceIndex: null,
      artifact: outer.artifact ?? null,
      messageId: data.messageId ?? null,
      requestId: data.requestId ?? null,
      parentItemId: data.parentItemId ?? null,
      providerSessionId: null,
      provider: null,
    },
    updates: [],
    usage: null,
  };
}

/** Interprets provider events without conflating a permission decision with tool execution. */
export function providerActivity(row: ActivityRecord, event: ActivityEventV1, context: ActivityContext): void {
  const envelope = envelopeSchema.safeParse(row.data).data;
  const data = activityFields(envelope?.data);
  const { agentId, modelId } = context;
  event.source = modelId;
  event.target = agentId;
  event.category = 'model';
  if (providerLifecycle(row, event, context)) return;
  if (row.type === 'activity.requested' || row.type === 'activity.progress') {
    itemActivity(event, data, true, context);
    event.label = `${data.name ?? 'Tool'} ${row.type === 'activity.requested' ? 'requested' : 'running'}`;
    if (row.type === 'activity.requested') {
      event.status = 'observed';
      event.updates = [];
    }
  } else if (row.type === 'activity.started' || row.type === 'activity.completed') {
    itemActivity(event, data, row.type === 'activity.started', context);
  } else if (
    row.type.startsWith('repository.tool_') ||
    row.type.startsWith('tool.') ||
    row.type === 'integration.tool_authorized'
  ) {
    toolActivity(event, row.type, data, context);
  } else if (row.type === 'usage.updated') {
    event.usage = usageSnapshot(data);
  } else if (row.type === 'output.delta') {
    event.status = 'active';
    event.updates = [{ nodeId: modelId, status: 'active' }];
  } else if (row.type.includes('error') || row.type.includes('malformed')) {
    event.category = 'failure';
    event.status = 'unknown';
    event.preview ??= activityPreview(z.object({ message: z.string() }).safeParse(envelope?.data).data?.message);
  } else {
    event.source = agentId;
    event.target = 'controller';
    event.category = 'controller';
  }
}

function providerLifecycle(row: ActivityRecord, event: ActivityEventV1, context: ActivityContext): boolean {
  const envelope = envelopeSchema.safeParse(row.data).data;
  const data = activityFields(envelope?.data),
    result = activityFields(envelope?.result);
  const { agentId, modelId } = context;
  if (row.type === 'turn.requested') {
    event.source = 'controller';
    event.target = agentId;
    event.status = 'active';
    event.updates = [{ nodeId: agentId, status: 'active' }];
  } else if (row.type === 'session.connected') {
    event.source = agentId;
    event.target = modelId;
    event.label = data.model ? `Connected to ${data.model}` : 'Connected; model unavailable';
    event.updates = [{ nodeId: modelId, status: 'observed', ...(data.model ? { label: data.model } : {}) }];
  } else if (row.type === 'turn.result') {
    event.source = agentId;
    event.target = 'controller';
    event.status = activityStatus(result.status);
    if (activityFields(row.data).exitConfirmed !== true) event.status = 'unknown';
    event.updates = [
      { nodeId: agentId, status: event.status },
      { nodeId: modelId, status: event.status },
      { nodeId: `tools:${event.correlation.sessionId}`, status: 'unknown', onlyIfActive: true },
    ];
    event.preview = activityPreview(
      result.error ??
        z.object({ reply: z.object({ text: z.string() }).nullish() }).safeParse(envelope?.result).data?.reply?.text,
    );
    if (context.nodes.get(agentId)?.detail === 'review') event.category = 'review';
    if (event.status !== 'completed') event.category = 'failure';
  } else {
    return false;
  }
  return true;
}

function usageSnapshot(data: ReturnType<typeof activityFields>): ActivityEventV1['usage'] {
  return {
    input: data.inputTokens ?? null,
    output: data.outputTokens ?? null,
    cached: data.cachedInputTokens ?? null,
    scope: data.scope ?? 'unavailable',
  };
}

function itemActivity(
  event: ActivityEventV1,
  data: ReturnType<typeof activityFields>,
  started: boolean,
  context: ActivityContext,
): void {
  const tool = data.kind === 'tool';
  const endpoint = tool ? `tools:${event.correlation.sessionId}` : context.modelId;
  event.category = tool ? 'tool' : 'model';
  event.source = started ? context.agentId : endpoint;
  event.target = started ? endpoint : context.agentId;
  event.status = started ? 'active' : activityStatus(data.status);
  event.label = `${data.name ?? data.kind ?? 'Activity'} ${started ? 'started' : 'completed'}`;
  event.updates = [
    {
      nodeId: endpoint,
      status: event.status,
      ...(!tool && data.name && data.name !== 'agentMessage' ? { label: data.name } : {}),
    },
  ];
}

function toolActivity(
  event: ActivityEventV1,
  type: string,
  data: ReturnType<typeof activityFields>,
  context: ActivityContext,
): void {
  const tools = `tools:${event.correlation.sessionId}`;
  const result = type === 'repository.tool_result' || type === 'tool.deleted';
  event.category = 'tool';
  event.source = result ? tools : context.agentId;
  event.target = result ? context.agentId : tools;
  event.label = `${data.tool ?? 'Tool'}: ${type}`;
  event.status = type === 'tool.denied' ? 'failed' : 'observed';
  if (permissionEvents.has(type)) {
    event.source = 'controller';
    event.target = context.agentId;
  }
  // Older uncorrelated permissions and results are shown as facts, never paired by tool name.
}

/** Interprets controller operations. Review and repair remain controller-mediated facts. */
export function controllerActivity(
  row: ActivityRecord,
  event: ActivityEventV1,
  nodes: Map<string, ActivityNodeV1>,
): void {
  const data = activityFields(row.data);
  if (row.version !== null) {
    const entry = timelineEntry({ ...row, taskId: row.owner, version: row.version });
    event.label = entry.summary;
    event.preview = activityPreview(entry.note ?? undefined);
  }
  const kind = data.checkId ? 'check' : data.deliveryId ? 'delivery' : null;
  if (kind) {
    const id = `${kind}:${data.checkId ?? data.deliveryId}`;
    const start = row.type.endsWith('requested');
    nodes.set(id, {
      id,
      kind,
      label: kind === 'check' ? 'Checks and validation' : 'Local Git delivery',
      detail: id,
      status: 'unknown',
      groupId: kind,
    });
    event.category = kind === 'check' ? 'validation' : 'delivery';
    event.source = start ? 'controller' : id;
    event.target = start ? id : 'controller';
    event.status = start ? 'active' : activityStatus(data.outcome ?? data.phase);
    event.updates = [{ nodeId: id, status: event.status }];
    event.durationMs = checkDuration(row.data);
  }
  if (row.type.includes('repair') || row.type.includes('review') || row.type.includes('arbitration'))
    event.category = 'review';
  if (row.type.includes('failed') || row.type.includes('blocked') || row.type.includes('recovery'))
    event.category = 'failure';
}

function checkDuration(value: unknown): number | null {
  const data = z.object({ result: z.object({ elapsedMs: z.number().nullish() }).nullish() }).safeParse(value).data;
  return data?.result?.elapsedMs ?? null;
}
