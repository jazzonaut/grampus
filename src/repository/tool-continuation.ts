// Owns executable pagination hints, preserving mode, limits and reference roots across pages.
import { z } from 'zod';
const cursor = z.looseObject({ nextOffset: z.number().nullable() });
/** Adds a complete next request to a paginated result, including repeated-read reminders. */
export function toolContinuation(tool: string, input: object, result: unknown): unknown {
  const parsed = cursor.safeParse(result);
  if (!parsed.success) return result;
  return {
    ...parsed.data,
    nextCall:
      parsed.data.nextOffset === null
        ? null
        : {
            tool,
            arguments: { ...input, offset: parsed.data.nextOffset },
          },
  };
}
