// Pins the parts of the Claude Agent SDK message stream that Grampus relies on. The SDK is pinned and
// its TypeScript types describe the stream, but `GRAMPUS_CLAUDE_COMMAND` may point at a different Claude
// executable, so the fields that decide identity, results and usage are also validated at run time:
//
// - `system/init` and `result` messages decide session identity and the turn outcome; a mismatch is a
//   `ProtocolError` that fails the turn.
// - Assistant usage, stream deltas, usage samples and MCP status only inform progress; a mismatch is
//   skipped (and journaled as `protocol.malformed` where it is a turn message), so usage stays unknown.
// - A message `type` the pinned SDK does not declare is journaled once as `protocol.unrecognized` and
//   ignored. `claudeMessageTypes` is checked against the SDK's own union at compile time, so an SDK
//   upgrade that adds or removes a message type fails the build until this list is reviewed.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ProtocolError, describeIssues } from '../process/boundary.js';

const claudeMessageTypes = {
  assistant: true,
  user: true,
  result: true,
  system: true,
  stream_event: true,
  tool_progress: true,
  auth_status: true,
  tool_use_summary: true,
  rate_limit_event: true,
  prompt_suggestion: true,
  conversation_reset: true,
} satisfies Record<SDKMessage['type'], true>;

/** True when the pinned SDK declares this message type. */
export function isKnownClaudeMessageType(type: string): boolean {
  return Object.hasOwn(claudeMessageTypes, type);
}

/** The account the SDK reports; only these fields decide whether a subscription login is in use. */
export const claudeAccountSchema = z.looseObject({
  apiProvider: z.string().nullish(),
  subscriptionType: z.string().nullish(),
  tokenSource: z.string().nullish(),
  apiKeySource: z.string().nullish(),
});
export type ClaudeAccount = z.infer<typeof claudeAccountSchema>;

/** `system/init`: the session the CLI actually started, its model and its MCP servers. */
export const claudeInitSchema = z.object({
  session_id: z.string().min(1),
  model: z.string(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
});

const modelUsageSchema = z.record(
  z.string(),
  z.looseObject({ inputTokens: z.unknown(), outputTokens: z.unknown(), cacheReadInputTokens: z.unknown() }),
);
/** Per-model cumulative usage; values that are not finite non-negative numbers make the total unknown. */
export type ClaudeModelUsage = z.infer<typeof modelUsageSchema>;

/** The final `result` message of a turn. */
export const claudeResultSchema = z.object({
  subtype: z.string(),
  is_error: z.boolean(),
  modelUsage: modelUsageSchema,
  total_cost_usd: z.unknown(),
  structured_output: z.unknown().optional(),
  result: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});

/** Top-level assistant message usage, used for the live context size. */
export const claudeAssistantUsageSchema = z.object({
  parent_tool_use_id: z.string().nullish(),
  message: z.looseObject({
    usage: z.looseObject({
      input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
    }),
  }),
});

/** A streamed text delta. Other stream events are ordinary and ignored. */
export const claudeTextDeltaSchema = z.object({
  event: z.object({
    type: z.literal('content_block_delta'),
    delta: z.object({ type: z.literal('text_delta'), text: z.string() }),
  }),
});

/** The experimental usage sample (`usage_EXPERIMENTAL_...`); failures are ignored by design. */
export const claudeUsageSampleSchema = z.object({
  session: z.object({ model_usage: modelUsageSchema, total_cost_usd: z.unknown() }),
});

/** `mcpServerStatus()` entries. */
export const claudeMcpStatusSchema = z.array(z.looseObject({ name: z.string(), status: z.string() }));

/** Parse a message Grampus cannot proceed without; a mismatch is a `ProtocolError` naming the message. */
export function parseClaudeMessage<S extends z.ZodType>(messageType: string, schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ProtocolError('claude', messageType, describeIssues(result.error), { cause: result.error });
  return result.data;
}
