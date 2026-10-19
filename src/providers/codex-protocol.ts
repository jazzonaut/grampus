// Pins the subset of the `codex app-server` JSON-RPC protocol that Grampus consumes. Codex is not
// version-pinned, so this module is where protocol drift becomes visible:
//
// - Responses (`account/read`, `config/read`, `thread/start|resume`, `turn/start`, `mcpServerStatus/list`)
//   are parsed with `parseCodexResponse`; a mismatch is a `ProtocolError` naming the method and fields,
//   and fails the connection or turn.
// - Notifications Grampus acts on (turn and item lifecycle, patches, agent messages) are parsed by
//   `classifyCodexNotification`. A malformed control notification is a `ProtocolError` that fails the
//   turn; a malformed observational one (deltas, token usage, errors) is reported as `malformed` and
//   skipped, so usage stays unknown rather than wrong.
// - Methods Grampus does not know are reported as `unrecognized` with a bounded, sanitised excerpt for
//   a `protocol.unrecognized` journal event, and are otherwise ignored. They never crash a turn.
// - Server requests (`item/tool/call`, `item/fileChange/requestApproval`) are parsed with `safeParse`
//   by the adapter; anything that does not match is declined, never approved.
//
// Object schemas drop unknown fields, so additive protocol changes are tolerated. The exception is
// the patch approval request, which is strict: an extra field could ask for broader permissions.
import { z } from 'zod';
import { editLimits } from '../config/limits.js';
import { ProtocolError, boundedExcerpt, describeIssues } from '../process/boundary.js';

const id = z.string().min(1);

/** `account/read`: only a ChatGPT subscription login is accepted. */
export const accountReadSchema = z.object({ account: z.looseObject({ type: z.string() }).nullable() });

/** `config/read`: the effective configuration; Grampus only carries MCP server tables into the thread. */
export const configReadSchema = z.object({
  config: z.looseObject({ mcp_servers: z.record(z.string(), z.record(z.string(), z.unknown())).nullish() }),
});

/** The sandbox shape Codex reports for a read-only thread; anything else means it was not confirmed. */
export const readOnlySandboxSchema = z.object({ type: z.literal('readOnly'), networkAccess: z.boolean().optional() });

/** `thread/start` and `thread/resume`. Approval and sandbox fields are checked by the adapter for editing. */
export const threadStartSchema = z.object({
  thread: z.object({ id }),
  model: z.string(),
  approvalPolicy: z.unknown().optional(),
  approvalsReviewer: z.unknown().optional(),
  sandbox: z.unknown().optional(),
});

/** `turn/start`: the acknowledged turn id. */
export const turnStartSchema = z.object({ turn: z.object({ id }) });

/** One page of `mcpServerStatus/list`. */
export const mcpStatusPageSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullish(),
      tools: z.record(z.string(), z.unknown()).nullish(),
      authStatus: z.string().nullish(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type McpStatusPage = z.infer<typeof mcpStatusPageSchema>;

/** One file of a native patch. Moves, other kinds and oversized or binary diffs are refused. */
export const codexFileChangeSchema = z.strictObject({
  path: z.string(),
  kind: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('update'), move_path: z.null().optional() }),
    z.strictObject({ type: z.literal('add') }),
    z.strictObject({ type: z.literal('delete') }),
  ]),
  diff: z
    .string()
    .refine(diff => !diff.includes('\0') && Buffer.byteLength(diff) <= editLimits.payloadBytes, 'Unbounded diff'),
});
export type CodexFileChange = z.infer<typeof codexFileChangeSchema>;

/** `item/tool/call`: a dynamic repository tool call. A namespace would mean a tool Grampus did not define. */
export const toolCallRequestSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  namespace: z.null().optional(),
});

/** `item/fileChange/requestApproval`. Strict: `grantRoot` or any unknown field asks for more than one patch. */
export const patchApprovalRequestSchema = z.strictObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.unknown().optional(),
  grantRoot: z.null().optional(),
  startedAtMs: z.unknown().optional(),
});

// Notifications. `threadId` is checked before these run; fixtures and older servers may omit `turnId`.
const turnScoped = { threadId: z.string(), turnId: z.string().optional() };
const itemSchema = z.looseObject({ type: z.string() });
const fileChangeItemSchema = z.object({ id, type: z.literal('fileChange'), status: z.string(), changes: z.unknown() });
const agentMessageItemSchema = z.object({ type: z.literal('agentMessage'), text: z.string() });
const tokenCountsSchema = z
  .object({
    inputTokens: z.number().nullish(),
    outputTokens: z.number().nullish(),
    cachedInputTokens: z.number().nullish(),
  })
  .nullish();

const notification = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ method: z.literal(method), params });

/** Notifications that drive turn state and patch authorization; a malformed one fails the turn. */
const controlNotificationSchema = z.discriminatedUnion('method', [
  notification('turn/started', z.object({ threadId: z.string(), turn: z.object({ id }) })),
  notification(
    'turn/completed',
    z.object({
      threadId: z.string(),
      turn: z.object({ id, status: z.string(), error: z.looseObject({ message: z.string().nullish() }).nullish() }),
    }),
  ),
  notification('item/started', z.object({ ...turnScoped, item: itemSchema })),
  notification('item/completed', z.object({ ...turnScoped, item: itemSchema })),
  notification('item/fileChange/patchUpdated', z.object({ ...turnScoped, itemId: id, changes: z.unknown() })),
]);

/** Notifications that only inform progress and usage; a malformed one is journaled and skipped. */
const observationalNotificationSchema = z.discriminatedUnion('method', [
  notification('item/agentMessage/delta', z.object({ ...turnScoped, delta: z.string() })),
  notification(
    'thread/tokenUsage/updated',
    z.object({
      ...turnScoped,
      tokenUsage: z.object({
        last: tokenCountsSchema,
        total: tokenCountsSchema,
        modelContextWindow: z.number().nullish(),
      }),
    }),
  ),
  notification(
    'error',
    z.object({ ...turnScoped, error: z.looseObject({ message: z.string() }), willRetry: z.boolean().optional() }),
  ),
]);

const methods = (schema: { options: readonly { shape: { method: { value: string } } }[] }) =>
  new Set(schema.options.map(option => option.shape.method.value));
const controlMethods = methods(controlNotificationSchema);
const observationalMethods = methods(observationalNotificationSchema);

/**
 * Methods Codex is known to send that Grampus deliberately ignores; they are not reported as drift.
 * `codex/event/*` is the legacy mirror of the same events and is ignored by prefix.
 */
const ignoredNotifications = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/compacted',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'account/updated',
  'account/rateLimits/updated',
  'account/login/completed',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'serverRequest/resolved',
  'deprecationNotice',
  'configWarning',
  'windows/worldWritableWarning',
]);

/** True for notifications Grampus acts on; those are only accepted for the session's own thread. */
export function isKnownCodexNotification(method: string): boolean {
  return controlMethods.has(method) || observationalMethods.has(method);
}

/** The thread a notification belongs to, or null when it carries none (global notifications). */
export function notificationThread(params: unknown): string | null {
  const scope = z.looseObject({ threadId: z.string() }).safeParse(params);
  return scope.success ? scope.data.threadId : null;
}

/** The id of a completed item, or null when it has none. */
export function itemId(item: z.output<typeof itemSchema>): string | null {
  const parsed = z.looseObject({ id }).safeParse(item);
  return parsed.success ? parsed.data.id : null;
}

/** A known notification with validated parameters, discriminated by `method`. */
export type CodexNotification =
  z.output<typeof controlNotificationSchema> | z.output<typeof observationalNotificationSchema>;

/** What a notification means to the adapter. Only `notification` carries data the controller acts on. */
export type CodexMessage =
  | { kind: 'notification'; notification: CodexNotification }
  | { kind: 'ignored'; method: string }
  | { kind: 'unrecognized'; method: string; excerpt: string }
  | { kind: 'malformed'; method: string; issues: string[]; excerpt: string };

/**
 * Classify one notification. Throws `ProtocolError` only for a malformed control notification, which the
 * transport turns into a failed turn; every other unexpected shape is returned for journaling.
 */
export function classifyCodexNotification(method: string, params: unknown): CodexMessage {
  if (controlMethods.has(method)) {
    const result = controlNotificationSchema.safeParse({ method, params });
    if (!result.success)
      throw new ProtocolError('codex', method, describeIssues(result.error), { cause: result.error });
    return { kind: 'notification', notification: result.data };
  }
  if (observationalMethods.has(method)) {
    const result = observationalNotificationSchema.safeParse({ method, params });
    if (!result.success)
      return { kind: 'malformed', method, issues: describeIssues(result.error), excerpt: boundedExcerpt(params) };
    return { kind: 'notification', notification: result.data };
  }
  if (ignoredNotifications.has(method) || method.startsWith('codex/event/')) return { kind: 'ignored', method };
  return { kind: 'unrecognized', method, excerpt: boundedExcerpt(params) };
}

/** A file change item as it appears in `item/started` and `item/completed`, or null for other items. */
export function fileChangeItem(item: z.output<typeof itemSchema>): z.output<typeof fileChangeItemSchema> | null {
  if (item.type !== 'fileChange') return null;
  const result = fileChangeItemSchema.safeParse(item);
  if (!result.success)
    throw new ProtocolError('codex', 'item fileChange', describeIssues(result.error), { cause: result.error });
  return result.data;
}

/** The final agent message text of an `item/completed`, or null for other items. */
export function agentMessageText(item: z.output<typeof itemSchema>): string | null {
  if (item.type !== 'agentMessage') return null;
  const result = agentMessageItemSchema.safeParse(item);
  if (!result.success)
    throw new ProtocolError('codex', 'item agentMessage', describeIssues(result.error), { cause: result.error });
  return result.data.text;
}

/** Parse a JSON-RPC response for `method`; a mismatch is a `ProtocolError` naming the method. */
export function parseCodexResponse<S extends z.ZodType>(method: string, schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError('codex', method, describeIssues(result.error), { cause: result.error });
  return result.data;
}
