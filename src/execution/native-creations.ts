// Owns the native creation inventory derived from controller-authorised file actions, never agent claims.
import { z } from 'zod';
import type { RepositorySnapshot } from '../repository/artifacts.js';

const authorisedEdit = z.object({
  runId: z.string(),
  data: z.object({
    tool: z.enum(['Write', 'Edit', 'apply_patch']),
    path: z.string().nullable().optional(),
    paths: z.array(z.string()).optional(),
  }),
});

/** Surviving native creations must remain in the artifact even if a later edit changes ignore rules. */
export function nativeCreationPaths(
  events: readonly { type: string; data: unknown }[],
  runId: string,
  before: RepositorySnapshot,
): string[] {
  const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const existing = new Set(before.files.filter(file => file.sha256 !== null).map(file => key(file.path)));
  const paths = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'tool.authorized') continue;
    const parsed = authorisedEdit.safeParse(event.data);
    if (!parsed.success || parsed.data.runId !== runId) continue;
    const action = parsed.data.data;
    for (const path of action.paths ?? (action.path ? [action.path] : [])) {
      if (!existing.has(key(path))) paths.set(key(path), path);
    }
  }
  return [...paths.values()];
}
