// Pins the arguments agents may pass to the Grampus repository tools (`repositoryToolDefinitions` is the
// JSON Schema the providers advertise; these zod schemas are what the controller enforces). Arguments
// are model output and never trusted: unknown keys, wrong types, control characters and out-of-range
// offsets are refused with a `BoundaryError` (`tool-arguments`) whose message is returned to the agent as
// the tool error, so it can correct the call. Semantic checks (inventory membership, modes, sides) stay
// with the tool implementation.
import { z } from 'zod';
import { repositoryToolLimits } from '../config/limits.js';
import { BoundaryError, describeIssues } from '../process/boundary.js';

const invalidText = 'Invalid repository tool text';
const invalidRange = 'Invalid repository tool offset or limit';

/** Bounded single-line text. */
const text = z
  .string({ error: invalidText })
  .max(repositoryToolLimits.argumentCharacters, { error: invalidText })
  .refine(value => ![...value].some(character => character.charCodeAt(0) < 0x20), { error: invalidText });
/** A non-negative safe integer; the tool applies its own upper bound and default. */
const count = z
  .number({ error: invalidRange })
  .int({ error: invalidRange })
  .min(0, { error: invalidRange })
  .max(Number.MAX_SAFE_INTEGER, { error: invalidRange });

const optional = <T extends z.ZodType>(schema: T) => schema.optional();

/** `grampus_list_files`. */
export const listFilesArguments = z.strictObject({
  root: optional(text),
  query: optional(text),
  offset: optional(count),
});
/** `grampus_read_file`; `mode` is checked by the tool (lines or characters). */
export const readFileArguments = z.strictObject({
  root: optional(text),
  path: optional(text),
  mode: optional(text),
  offset: optional(count),
  limit: optional(count),
});
/** Bounded related-file reads; each item retains its own continuation cursor. */
export const readFilesArguments = z.strictObject({
  root: optional(text),
  paths: z.array(text).min(1).max(repositoryToolLimits.batchFiles).optional(),
  ranges: z
    .array(z.strictObject({ path: text, offset: optional(count), limit: optional(count) }))
    .min(1)
    .max(repositoryToolLimits.batchFiles)
    .optional(),
});
/** `grampus_search`. */
export const searchArguments = z.strictObject({
  root: optional(text),
  query: optional(text),
  queries: z.array(text.min(1)).min(1).max(repositoryToolLimits.searchQueries).optional(),
  path: optional(text),
  glob: optional(text),
  mode: z.enum(['lines', 'files']).optional(),
  offset: optional(count),
});
/**
 * `grampus_read_changes`; `side` is checked by the tool (before or after). It takes no `root`: reference
 * folders are pinned trees without bound changes.
 */
export const readChangesArguments = z.strictObject({
  path: optional(text),
  side: optional(text),
  offset: optional(count),
  limit: optional(count),
});
/** `grampus_suggest_reference_folder`; the tool requires an absolute path and a reason. */
export const suggestReferenceArguments = z.strictObject({ path: optional(text), reason: optional(text) });
/** `grampus_read_check`; `stream` is checked by the tool (stdout, stderr or spec). */
export const readCheckArguments = z.strictObject({
  checkId: optional(text),
  stream: optional(text),
  offset: optional(count),
  limit: optional(count),
});
/** Dependency reads validate package names and paths themselves; only the shape is fixed here. */
export const readDependencyArguments = z.strictObject({
  package: z.unknown(),
  path: z.unknown().optional(),
  from: z.unknown().optional(),
  query: z.unknown().optional(),
  offset: z.unknown().optional(),
  limit: z.unknown().optional(),
});
export type ReadDependencyArguments = z.infer<typeof readDependencyArguments>;

const unknownArgument = 'Unknown repository tool argument';

/** Arguments of one exploration tool call (list, read, search, changes), discriminated by tool. */
export type ExplorationCall =
  | { tool: 'grampus_list_files'; args: z.output<typeof listFilesArguments> }
  | { tool: 'grampus_read_file'; args: z.output<typeof readFileArguments> }
  | { tool: 'grampus_read_files'; args: z.output<typeof readFilesArguments> }
  | { tool: 'grampus_read_changes'; args: z.output<typeof readChangesArguments> }
  | { tool: 'grampus_search'; args: z.output<typeof searchArguments> };

/** Parse an exploration tool call; any other tool name is refused. */
export function parseExplorationCall(name: string, input: unknown): ExplorationCall {
  switch (name) {
    case 'grampus_list_files':
      return { tool: name, args: parseToolArguments(name, listFilesArguments, input, unknownArgument) };
    case 'grampus_read_file':
      return { tool: name, args: parseToolArguments(name, readFileArguments, input, unknownArgument) };
    case 'grampus_read_files':
      return { tool: name, args: parseToolArguments(name, readFilesArguments, input, unknownArgument) };
    case 'grampus_read_changes':
      return { tool: name, args: parseToolArguments(name, readChangesArguments, input, unknownArgument) };
    case 'grampus_search':
      return { tool: name, args: parseToolArguments(name, searchArguments, input, unknownArgument) };
    default:
      throw new BoundaryError(
        { kind: 'tool-arguments', source: name },
        ['(root): unknown tool'],
        'Invalid repository tool',
      );
  }
}

/**
 * Parse tool arguments. An unknown key is reported as `unknownKey`, which names the tool's contract;
 * any other problem uses the field's own message.
 */
export function parseToolArguments<S extends z.ZodType>(
  tool: string,
  schema: S,
  input: unknown,
  unknownKey: string,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues;
  const message = issues.some(issue => issue.code === 'unrecognized_keys')
    ? unknownKey
    : (issues[0]?.message ?? 'Invalid repository tool arguments');
  throw new BoundaryError({ kind: 'tool-arguments', source: tool }, describeIssues(result.error), message, {
    cause: result.error,
  });
}
