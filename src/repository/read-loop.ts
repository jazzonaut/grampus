// Owns repeated-read detection across provider adapters. Changed content has a different identity,
// so legitimate reads after editing remain available while unchanged pages cannot fill the context.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { repositoryToolLimits } from '../config/limits.js';

const cursor = z.object({ nextOffset: z.number().nullable().optional() });

/** A provider turn that keeps reading unchanged pages must settle before any continuation. */
export class RepositoryReadLoopError extends Error {}

/** One turn's bounded read history, shared by native repository tools on both providers. */
export class ReadLoop {
  private readonly seen = new Map<string, { count: number; progress: number }>();
  private progress = 0;

  /** Returns the original result or a compact reminder; throws when repeated reads cannot progress. */
  observe(tool: string, input: object, result: unknown): unknown {
    if (tool === 'grampus_suggest_reference_folder') return result;
    const key = createHash('sha256')
      .update(tool)
      .update(JSON.stringify(input, Object.keys(input).sort()))
      .update(JSON.stringify(result))
      .digest('hex');
    const previous = this.seen.get(key);
    if (!previous) this.progress++;
    const count = previous?.progress === this.progress ? previous.count + 1 : 1;
    this.seen.set(key, { count, progress: this.progress });
    if (count >= repositoryToolLimits.repeatedReadStop)
      throw new RepositoryReadLoopError(
        `Repeated repository read of unchanged content: ${tool}. Follow nextOffset or narrow the request before continuing.`,
      );
    if (count < repositoryToolLimits.repeatedReadHint) return result;
    const parsed = cursor.safeParse(result);
    return {
      repeated: true,
      nextOffset: parsed.success ? (parsed.data.nextOffset ?? null) : null,
      note: 'This exact request already returned unchanged content. Use the supplied nextOffset for the next page, change the query or use the content already received.',
    };
  }
}
