// Owns validation of data that crosses a process, file or network boundary into Grampus: provider
// protocols, supervisor output and receipts, worker request files, journal records, Orca output, agent
// tool arguments, dashboard request bodies and CLI input. Each boundary pins its contract in a zod schema
// beside the module that owns it; this module turns schema failures into categorised errors so that a
// diagnostic can say which contract changed and where, without echoing unbounded or secret content.
import type { z } from 'zod';
import { boundaryLimits } from '../config/limits.js';
import type { Provider } from '../providers/types.js';

/** Which external contract a value failed. Diagnostics group protocol drift by this. */
export type BoundaryKind =
  | 'provider-protocol'
  | 'agent-reply'
  | 'supervisor-protocol'
  | 'supervisor-receipt'
  | 'worker-request'
  | 'journal-record'
  | 'orca-output'
  | 'git-output'
  | 'tool-arguments'
  | 'http-request'
  | 'cli-input'
  | 'configuration'
  | 'process-identity';

/** Where a value came from: the boundary kind plus a short, non-secret source name such as a file or method. */
export interface BoundaryContext {
  kind: BoundaryKind;
  source: string;
}

/**
 * A value from outside the controller did not match its pinned contract. `issues` are field-level
 * descriptions (`path: problem`), bounded by `boundaryLimits.reportedIssues`; they never contain values.
 */
export class BoundaryError extends Error {
  readonly kind: BoundaryKind;
  readonly source: string;
  readonly issues: readonly string[];
  constructor(context: BoundaryContext, issues: readonly string[], message?: string, options?: ErrorOptions) {
    super(message ?? `Invalid ${context.kind} from ${context.source}: ${issues.join('; ')}`, options);
    this.name = 'BoundaryError';
    this.kind = context.kind;
    this.source = context.source;
    this.issues = issues;
  }
}

/**
 * A provider sent a message that does not match the protocol Grampus was written against. `messageType`
 * is the JSON-RPC method or SDK message type, so a failure names exactly which part of the protocol drifted.
 */
export class ProtocolError extends BoundaryError {
  readonly provider: Provider;
  readonly messageType: string;
  constructor(provider: Provider, messageType: string, issues: readonly string[], options?: ErrorOptions) {
    super(
      { kind: 'provider-protocol', source: `${provider} ${messageType}` },
      issues,
      `${provider === 'codex' ? 'Codex' : 'Claude'} protocol changed: ${messageType} ${issues.join('; ')}`,
      options,
    );
    this.name = 'ProtocolError';
    this.provider = provider;
    this.messageType = messageType;
  }
}

/**
 * Journal data for a provider message Grampus does not know (`protocol.unrecognized`) or knows but could
 * not validate and skipped (`protocol.malformed`). Both are diagnostics for protocol drift, never errors.
 */
export interface ProtocolDiagnostic {
  provider: Provider;
  messageType: string;
  excerpt: string;
  issues?: string[];
}

/** A provider event for the session journal describing an unrecognised or skipped malformed message. */
export function protocolDiagnostic(
  type: 'protocol.unrecognized' | 'protocol.malformed',
  data: ProtocolDiagnostic,
): { type: string; data: ProtocolDiagnostic } {
  return { type, data };
}

/**
 * Bounds unrecognised-message diagnostics for one provider session: each message type is reported once,
 * and at most `boundaryLimits.unrecognizedMessageTypes` distinct types are reported in total.
 */
export class UnrecognizedMessages {
  private readonly seen = new Set<string>();
  /** True the first time a type is seen while under the bound; later sightings are not reported. */
  report(messageType: string): boolean {
    if (this.seen.has(messageType) || this.seen.size >= boundaryLimits.unrecognizedMessageTypes) return false;
    this.seen.add(messageType);
    return true;
  }
}

function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length ? issue.path.map(String).join('.') : '(root)';
}

/** Field-level issue descriptions without the offending values; at most `limit` plus a count of the rest. */
export function describeIssues(error: z.ZodError, limit: number = boundaryLimits.reportedIssues): string[] {
  const described = error.issues.map(issue =>
    issue.code === 'unrecognized_keys'
      ? `${issuePath(issue)}: unexpected ${issue.keys
          .slice(0, limit)
          .map(key => JSON.stringify(excerptText(key)))
          .join(', ')}`
      : `${issuePath(issue)}: ${issue.message}`,
  );
  return described.length > limit
    ? [...described.slice(0, limit), `${described.length - limit} more issues`]
    : described;
}

/**
 * Parse `value` with `schema` and return zod's output. Use this for foreign protocols, where unknown fields
 * are dropped and only what Grampus relies on is kept.
 *
 * @throws BoundaryError with field-level issues (and the zod error as `cause`) when the value does not match.
 */
export function parseBoundary<S extends z.ZodType>(schema: S, value: unknown, context: BoundaryContext): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BoundaryError(context, describeIssues(result.error), undefined, { cause: result.error });
  return result.data;
}

/**
 * Validate `value` against `schema` and return the same object, not zod's rebuilt copy. Use this for
 * records Grampus wrote itself (journal state, receipts, worker requests): zod emits keys in schema
 * order, and fences and digests compare these records by their serialised bytes, so the stored key
 * order must survive. The schema must not transform: its input and output types are the same `T`.
 *
 * @throws BoundaryError with field-level issues (and the zod error as `cause`) when the value does not match.
 */
export function validateInPlace<T>(schema: z.ZodType<T, T>, value: unknown, context: BoundaryContext): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BoundaryError(context, describeIssues(result.error), undefined, { cause: result.error });
  // The schema has just proved the shape, and it has no transforms, so the original value is a T.
  return value as T;
}

/** The `code` of a Node system error (`ENOENT`, `ESRCH`), or undefined for any other thrown value. */
export function systemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * `JSON.parse` whose syntax errors are categorised boundary errors instead of bare `SyntaxError`s.
 *
 * @throws BoundaryError (`(root): not valid JSON`, with the `SyntaxError` as `cause`) when `text` is not JSON.
 */
export function parseJson(text: string, context: BoundaryContext): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new BoundaryError(context, ['(root): not valid JSON'], undefined, { cause: error });
  }
}

const secretKey = /token|secret|password|passwd|credential|cookie|authorization|api[_-]?key|session[_-]?key/i;

function excerptText(value: string): string {
  // Control characters and bidirectional overrides are dropped so an excerpt cannot forge log lines.
  const clean = value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ');
  return clean.length > boundaryLimits.excerptStringCharacters
    ? `${clean.slice(0, boundaryLimits.excerptStringCharacters)}…(${clean.length} characters)`
    : clean;
}

function sanitise(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return excerptText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= boundaryLimits.excerptDepth) return Array.isArray(value) ? '[array]' : '[object]';
  if (Array.isArray(value)) {
    const items: unknown[] = value.slice(0, boundaryLimits.excerptEntries).map(item => sanitise(item, depth + 1));
    if (value.length > boundaryLimits.excerptEntries)
      items.push(`…${value.length - boundaryLimits.excerptEntries} more`);
    return items;
  }
  const entries = Object.entries(value);
  const kept = entries
    .slice(0, boundaryLimits.excerptEntries)
    .map(([key, item]) => [excerptText(key), secretKey.test(key) ? '[redacted]' : sanitise(item, depth + 1)]);
  if (entries.length > boundaryLimits.excerptEntries)
    kept.push(['…', `${entries.length - boundaryLimits.excerptEntries} more`]);
  return Object.fromEntries(kept);
}

/**
 * A bounded, sanitised JSON excerpt of an unexpected value for the journal: strings are shortened,
 * secret-looking keys are redacted, nesting and entry counts are capped and control characters removed.
 * It shows the shape that changed while keeping at most a short prefix of any string (such as a prompt or
 * file content) and no value under a secret-looking key.
 */
export function boundedExcerpt(value: unknown): string {
  const text = JSON.stringify(sanitise(value, 0)) ?? 'undefined';
  return text.length > boundaryLimits.excerptCharacters ? `${text.slice(0, boundaryLimits.excerptCharacters)}…` : text;
}
