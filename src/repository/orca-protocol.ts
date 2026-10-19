// Pins the JSON contract of the Orca CLI (`orca ... --json`) that Grampus relies on: the response
// envelope, `repo show`, `worktree create|list|show` and `worktree current` (doctor). Orca is not
// version-pinned. A response that does not match is a `BoundaryError` of kind `orca-output` naming the
// command and fields, and the operation stops: Grampus never guesses an Orca identity, path or host.
// Identity invariants that go beyond shape (local host, key format, id prefixes) are checked by orca.ts.
import { z } from 'zod';
import { BoundaryError, describeIssues, parseJson } from '../process/boundary.js';

const text = z.string().min(1);

/** Every `--json` response: either a result or a refusal with a machine-readable code. */
export const orcaEnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.unknown().optional() }).nullish(),
});

/** The host fields checked first, so a remote worktree is refused before any other field is trusted. */
export const orcaHostSchema = z.looseObject({
  hostId: z.unknown(),
  identity: z.looseObject({ executionHostId: z.unknown() }),
});

/** One worktree as Orca reports it. */
export const orcaWorktreeSchema = z.object({
  id: text,
  repoId: text,
  path: text,
  branch: text,
  displayName: text,
  hostId: z.literal('local'),
  instanceId: z.string(),
  identity: z.object({ executionHostId: z.literal('local'), instanceId: text, key: text }),
  isMainWorktree: z.boolean(),
  isArchived: z.boolean(),
  comment: z.unknown().optional(),
  baseRef: z.unknown().optional(),
});
export type OrcaWorktreeRecord = z.infer<typeof orcaWorktreeSchema>;

/** `repo show`. */
export const orcaRepoShowSchema = z.object({ repo: z.object({ id: text, path: text, kind: z.string() }) });

/** `worktree create` and `worktree show`. */
export const orcaWorktreeResultSchema = z.object({ worktree: z.unknown() });

/** `worktree list`: completeness and host scope are part of the contract. */
export const orcaWorktreeListSchema = z.object({
  worktrees: z.array(z.unknown()),
  totalCount: z.number(),
  truncated: z.boolean(),
  hostScope: z.object({ hostIds: z.array(z.string()), omittedHostIds: z.array(z.unknown()) }),
});

/** `worktree current` (doctor only). */
export const orcaCurrentSchema = z.object({ worktree: z.looseObject({ id: z.string().optional() }).nullish() });

/** Parse Orca output for `command`, or throw a categorised error naming it. */
export function parseOrca<S extends z.ZodType>(
  command: string,
  schema: S,
  value: unknown,
  message?: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = describeIssues(result.error);
    throw new BoundaryError(
      { kind: 'orca-output', source: command },
      issues,
      `${message ?? `Malformed Orca ${command} response`}: ${issues.join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/** Parse the JSON text of one Orca response. */
export function orcaJson(command: string, output: string): unknown {
  return parseJson(output, { kind: 'orca-output', source: command });
}
