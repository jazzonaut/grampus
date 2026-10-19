// Pins the Git plumbing output formats that snapshots and delivery verification parse: `ls-tree -r [-l] -z`,
// `ls-files --stage -z` and `cat-file --batch-check`. These are stable porcelain-free formats, but they are
// still text from another process: every field is checked here, and a line that does not match is a
// `BoundaryError` (`git-output`) rather than a value that silently becomes `undefined` in a comparison.
import { z } from 'zod';
import { BoundaryError, parseBoundary } from '../process/boundary.js';

function malformed(command: string, issue: string): BoundaryError {
  return new BoundaryError({ kind: 'git-output', source: command }, [issue], `Unexpected Git ${command} output`);
}

/** One `ls-tree -r -l -z` entry: `<mode> <type> <oid> <size>\t<path>`. Size is `-` for non-blobs. */
export function lsTreeLongEntry(entry: string): {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
} {
  const match = /^(\d{6}) ([a-z]+) ([a-f0-9]+) +(\d+|-)\t(.+)$/s.exec(entry);
  const [, mode, type, oid, size, path] = match ?? [];
  if (!mode || !type || !oid || !size || !path)
    throw malformed('ls-tree', 'entry does not match <mode> <type> <oid> <size>');
  return { mode, type, oid, size: size === '-' ? 0 : Number(size), path };
}

/** One `ls-tree -r -z` entry: `<mode> <type> <oid>\t<path>`. */
export function lsTreeEntry(entry: string): { mode: string; type: string; oid: string; path: string } {
  const match = /^(\d{6}) ([a-z]+) ([a-f0-9]+)\t(.+)$/s.exec(entry);
  const [, mode, type, oid, path] = match ?? [];
  if (!mode || !type || !oid || !path) throw malformed('ls-tree', 'entry does not match <mode> <type> <oid>');
  return { mode, type, oid, path };
}

/** One `ls-files --stage -z` entry: `<mode> <oid> <stage>\t<path>`. */
export function indexEntry(entry: string): { mode: string; oid: string; stage: string; path: string } {
  const match = /^(\d{6}) ([a-f0-9]+) (\d)\t(.+)$/s.exec(entry);
  const [, mode, oid, stage, path] = match ?? [];
  if (!mode || !oid || !stage || !path) throw malformed('ls-files', 'entry does not match <mode> <oid> <stage>');
  return { mode, oid, stage, path };
}

/** One `cat-file --batch-check` line for a blob: `<oid> blob <size>`; anything else (missing, other type) is null. */
export function blobCheckLine(line: string | undefined): { oid: string; bytes: number } | null {
  const match = /^([a-f0-9]+) blob (\d+)$/.exec(line ?? '');
  const [, oid, size] = match ?? [];
  return oid && size ? { oid, bytes: Number(size) } : null;
}

/** The `worktree list --porcelain -z` attributes Grampus reads; others (bare, detached, prunable) are ignored. */
const worktreeBlockSchema = z.object({
  worktree: z.string().min(1),
  HEAD: z.string().optional(),
  branch: z.string().optional(),
  locked: z.string().optional(),
});
export type WorktreeBlock = z.infer<typeof worktreeBlockSchema>;

/** Parse `worktree list --porcelain -z`: blocks separated by an empty field, `<name> <value>` attributes. */
export function worktreeList(output: string): WorktreeBlock[] {
  return output
    .split('\0\0')
    .filter(Boolean)
    .map(block => {
      const fields = Object.fromEntries(
        block
          .split('\0')
          .filter(Boolean)
          .map(field => {
            const space = field.indexOf(' ');
            return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
          }),
      );
      return parseBoundary(worktreeBlockSchema, fields, { kind: 'git-output', source: 'worktree list' });
    });
}
