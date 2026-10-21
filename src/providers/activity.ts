// Owns metadata-only provider activity extraction. Observational parsing never broadens tool permissions.
// The one argument kept is a redacted, shortened command preview, so live progress can say which
// command is running; tool output, file contents and other arguments are never captured.
import { z } from 'zod';
import { observabilityLimits } from '../config/limits.js';
import { sanitiseDetail } from '../health/health.js';
import type { AgentEvent } from './types.js';

/**
 * A command as a person would type it: a provider's shell wrapper (`pwsh -Command "..."`, `bash -lc
 * '...'`) is unwrapped, secrets are redacted and the text is shortened. Display only.
 */
export function commandPreview(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  const wrapped = /(?:^|\s)-(?:Command|c|lc)\s+(["']?)([\s\S]*?)\1\s*$/i.exec(command.trim());
  const text = sanitiseDetail(wrapped?.[2] ?? command);
  const limit = observabilityLimits.commandPreviewCharacters;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || null;
}

const name = z.string().min(1).max(observabilityLimits.activityNameCharacters);
const codexItem = z.object({
  turnId: z.string().optional(),
  item: z.object({
    id: z.string(),
    type: name,
    tool: name.optional(),
    server: name.optional(),
    status: name.optional(),
    durationMs: z.number().nonnegative().nullish(),
    command: z.string().optional(),
  }),
});
const toolKinds = new Set([
  'dynamicToolCall',
  'mcpToolCall',
  'fileChange',
  'commandExecution',
  'webSearch',
  'imageView',
]);

/** Captures item lifecycle only after the adapter has checked thread and turn ownership. */
export function codexActivity(method: string, params: unknown, emit: (event: AgentEvent) => void): void {
  if (method !== 'item/started' && method !== 'item/completed') return;
  const data = codexItem.safeParse(params).data;
  if (!data || (!toolKinds.has(data.item.type) && data.item.type !== 'agentMessage')) return;
  const { item } = data;
  emit({
    type: method === 'item/started' ? 'activity.started' : 'activity.completed',
    data: {
      id: item.id,
      providerTurnId: data.turnId ?? null,
      kind: toolKinds.has(item.type) ? 'tool' : 'model',
      name: item.tool ?? item.type,
      server: item.server ?? null,
      ...(item.type === 'commandExecution' && commandPreview(item.command)
        ? { detail: commandPreview(item.command) }
        : {}),
      status: item.status ?? (method === 'item/completed' ? 'completed' : 'inProgress'),
      durationMs: item.durationMs ?? null,
    },
  });
}

const blockSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: name.optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  input: z.object({ command: z.unknown().optional() }).loose().optional(),
});
const assistant = z.object({
  message: z.object({ id: z.string(), content: z.array(z.unknown()) }),
  parent_tool_use_id: z.string().nullish(),
  request_id: z.string().optional(),
});
const user = z.object({ message: z.object({ content: z.array(z.unknown()) }) });
const progress = z.object({ tool_use_id: z.string(), tool_name: name, elapsed_time_seconds: z.number().nonnegative() });
const stream = z.object({
  event: z.object({ type: z.string(), message: z.object({ id: z.string(), model: z.string() }).optional() }),
  parent_tool_use_id: z.string().nullish(),
});
const timings = z.object({
  duration_ms: z.number().nonnegative().optional(),
  duration_api_ms: z.number().nonnegative().optional(),
  ttft_ms: z.number().nonnegative().optional(),
});

/** Tracks streamed responses separately from generated tool requests and provider-reported results. */
export class ClaudeActivity {
  private responseId: string | null = null;
  constructor(private readonly emit: (event: AgentEvent) => void) {}

  /** Malformed metadata is ignored; the adapter separately validates control and authorisation fields. */
  message(type: string, value: unknown): void {
    if (type === 'stream_event') this.stream(value);
    if (type === 'assistant') this.assistant(value);
    if (type === 'user') this.results(value);
    if (type === 'result') {
      const data = timings.safeParse(value).data;
      if (data?.duration_ms !== undefined)
        this.emit({
          type: 'activity.metrics',
          data: {
            durationMs: data.duration_ms,
            apiDurationMs: data.duration_api_ms ?? null,
            ttftMs: data.ttft_ms ?? null,
          },
        });
    }
    if (type === 'tool_progress') {
      const data = progress.safeParse(value).data;
      if (data)
        this.emit({
          type: 'activity.progress',
          data: {
            id: data.tool_use_id,
            kind: 'tool',
            name: data.tool_name,
            elapsedMs: data.elapsed_time_seconds * 1000,
          },
        });
    }
  }

  private stream(value: unknown): void {
    const data = stream.safeParse(value).data;
    if (!data || data.parent_tool_use_id) return;
    const event = data.event;
    if (event.type === 'message_start' && event.message) {
      this.responseId = event.message.id;
      this.emit({
        type: 'activity.started',
        data: { id: this.responseId, kind: 'model', name: event.message.model, status: 'inProgress' },
      });
    }
    if (event.type === 'message_stop' && this.responseId) {
      this.emit({ type: 'activity.completed', data: { id: this.responseId, kind: 'model', status: 'completed' } });
      this.responseId = null;
    }
  }

  private assistant(value: unknown): void {
    const data = assistant.safeParse(value).data;
    if (!data) return;
    for (const raw of data.message.content) {
      const block = blockSchema.safeParse(raw).data;
      if (block?.type !== 'tool_use' || !block.id || !block.name) continue;
      this.emit({
        type: 'activity.requested',
        data: {
          id: block.id,
          kind: 'tool',
          name: block.name,
          ...(block.name === 'Bash' && commandPreview(block.input?.command)
            ? { detail: commandPreview(block.input?.command) }
            : {}),
          messageId: data.message.id,
          requestId: data.request_id ?? null,
          parentItemId: data.parent_tool_use_id ?? null,
        },
      });
    }
  }

  private results(value: unknown): void {
    const data = user.safeParse(value).data;
    if (!data) return;
    for (const raw of data.message.content) {
      const block = blockSchema.safeParse(raw).data;
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      this.emit({
        type: 'activity.completed',
        data: { id: block.tool_use_id, kind: 'tool', status: block.is_error ? 'failed' : 'completed' },
      });
    }
  }
}
